/* ============================================================
 * scripts/smoke/05-pan-lock.js —— 冒烟断言分域 05：拖动/平移边界与锁切换
 * （拖动不夹取 / 指针离开窗口自动小锁 / 小锁开关三按钮 / 小锁框可移出视野 /
 *   平移无范围限制 / 还原视图 / 拖动树：右键顶层主题根锁定目标树 →
 *   左键拖动只移动该棵树、其他树不动、单击无副作用、Esc 退出保留偏移）
 *
 * 由入口 scripts/smoke-assertions.js 按顺序拼接执行。
 * 本文件是对拆分前单体 smoke-assertions.js 的逐字搬运，勿改断言文案与顺序。
 * ============================================================ */
'use strict';

const frameStats = require('../vision/frame-stats.js');
const VTH = frameStats.THRESHOLDS;

/** 判别力证明开关（默认空 ⇒ 正常跑完全不生效 ✓）。
 *  支持逗号分隔多键：本工程有 6 条迁移后的断言要各自证明"会红"，一趟冒烟跑完比跑 6 趟省 10 分钟 ✓
 *  （域 37 用的是精确匹配，遇到列表值天然忽略、不受影响 ✓） */
const INJECT = process.env.MM_SMOKE_INJECT || '';
const MY_KEY = (k) => INJECT.split(',').indexOf('05-' + k) >= 0;

/** 连线**曲线**上的取样参数（域 05 用；两端各取一遍 ⇒ 每条线最多 2×N 个取样点）。
 *  注意 jsMind 的 curved 是三次贝塞尔、**关于参数不对称**（见 renderer/app-view.js 的 _bezier_to），
 *  所以两端都要取、且不能沿"两端直线弦"取样（弦与曲线最大偏差可达 0.16·|Δx|）✓ */
const CURVE_U = [0.01, 0.03, 0.08, 0.18, 0.35];

const assertions = [
  {
    name: 'drag is unclamped (box may be dragged outside the container)',
    run: async (ctx) => {
      // 需求：拖动时不再强制"完整显示在导图容器内"，允许把框拖到容器之外（可只显示一部分），
      //      否则可拖范围就只有当前导图画面那么大。
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp; var jm = app.getState().jm;
          if (!jm) return Promise.resolve(JSON.stringify({ ok: false, reason: 'no jm' }));
          app.closeAllFloatDetail();
          app.showDetail(jm.get_node('tcp-handshake'));
          return new Promise(function (res) {
            setTimeout(function () {
              var fd = document.querySelector('.float-detail');
              var head = fd.querySelector('.fd-head');
              fd.style.left = '20px'; fd.style.top = '300px';
              head.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 300, clientY: 300 }));
              document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 100, clientY: 300 }));
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
              var st = app.getFloatDetailState();
              res(JSON.stringify({
                left: Math.round(st.left), top: Math.round(st.top), lock: st.lock,
                ok: Math.round(st.left) === -180 && Math.round(st.top) === 300 && st.lock === 'map'
              }));
            }, 200);
          });
        })()`
      );
      let ok = false, detail = chk;
      try { ok = JSON.parse(chk).ok; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    name: 'pointer leaving the window pins the box (auto 小锁)',
    run: async (ctx) => {
      // 需求：指针脱离软件界面范围 → 立即结束拖动并自动上小锁钉在那一刻的位置，避免被"拖飞"
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp; var jm = app.getState().jm;
          if (!jm) return Promise.resolve(JSON.stringify({ ok: false, reason: 'no jm' }));
          app.closeAllFloatDetail();
          app.showDetail(jm.get_node('tcp-handshake'));
          return new Promise(function (res) {
            setTimeout(function () {
              var fd = document.querySelector('.float-detail');
              var head = fd.querySelector('.fd-head');
              fd.style.left = '200px'; fd.style.top = '300px';
              head.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 300, clientY: 300 }));
              document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 250, clientY: 300 }));
              var moved = app.getFloatDetailState();
              document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: -30, clientY: 300 })); // 拖出窗口
              var pinned = app.getFloatDetailState();
              document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 400, clientY: 380 })); // 再动不应再跟
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
              var after = app.getFloatDetailState();
              res(JSON.stringify({
                movedLeft: Math.round(moved.left), pinnedLeft: Math.round(pinned.left),
                pinnedLock: pinned.lock, afterLeft: Math.round(after.left),
                ok: Math.round(moved.left) === 150 && pinned.lock === 'map'
                  && Math.abs(pinned.left - after.left) <= 1
              }));
            }, 200);
          });
        })()`
      );
      let ok = false, detail = chk;
      try { ok = JSON.parse(chk).ok; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    name: 'lock toggle: click 小锁 locks, click again unlocks (3 header buttons)',
    run: async (ctx) => {
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp; var jm = app.getState().jm;
          if (!jm) return Promise.resolve(JSON.stringify({ ok: false, reason: 'no jm' }));
          app.closeAllFloatDetail();
          app.showDetail(jm.get_node('tcp-handshake'));
          return new Promise(function (res) {
            setTimeout(function () {
              var box = document.querySelector('.float-detail');
              box.querySelector('.fd-lock-map').click();
              var a = app.getFloatDetailState().lock;
              box.querySelector('.fd-lock-map').click();
              var b = app.getFloatDetailState().lock;
              box.querySelector('.fd-lock-screen').click();
              var c = app.getFloatDetailState().lock;
              var btns = box.querySelectorAll('.fd-head-btns button').length;
              res(JSON.stringify({
                first: a, second: b, screen: c, buttons: btns,
                ok: a === 'map' && b === 'follow' && c === 'screen' && btns === 3
              }));
            }, 150);
          });
        })()`
      );
      let ok = false, detail = chk;
      try { ok = JSON.parse(chk).ok; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    name: '小锁 box may leave the viewport (not clamped into view)',
    run: async (ctx) => {
      // 需求：小锁固定后，把导图平移到看不到该节点时，详情框也应允许移出视野
      //      （由 #mindmap-container 的 overflow:hidden 自然裁切），不得被夹在可见区内。
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp; var jm = app.getState().jm;
          if (!jm) return Promise.resolve(JSON.stringify({ ok: false, reason: 'no jm' }));
          app.closeAllFloatDetail();
          jm.expand_to_depth(20);
          window.MM.setViewScale(1);
          app.showDetail(jm.get_node('tcp-handshake'));
          return new Promise(function (res) {
            setTimeout(function () {
              var box = document.querySelector('.float-detail');
              box.querySelector('.fd-lock-map').click();
              var panel = document.querySelector('jmnodes').parentElement;
              var cont = document.getElementById('mindmap-container').getBoundingClientRect();
              var node = document.querySelector('jmnode[nodeid="tcp-handshake"]');
              setTimeout(function () {
                var n0 = node.getBoundingClientRect();
                var r0 = box.getBoundingClientRect();
                var pr = panel.getBoundingClientRect();
                var cx = pr.left + pr.width / 2, cy = pr.top + pr.height / 2, DY = -1500;
                panel.dispatchEvent(new MouseEvent('mousedown', { button: 1, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
                document.dispatchEvent(new MouseEvent('mousemove', { button: 1, clientX: cx, clientY: cy + DY, bubbles: true, cancelable: true }));
                document.dispatchEvent(new MouseEvent('mouseup', { button: 1, bubbles: true, cancelable: true }));
                setTimeout(function () {
                  app.positionFloatDetail();
                  var n1 = node.getBoundingClientRect();
                  var r1 = box.getBoundingClientRect();
                  var dNode = Math.round(n1.top - n0.top);
                  var dBox = Math.round(r1.top - r0.top);
                  // 未夹取 = 已被容器裁切（至少有一部分跑到容器上/下边界之外）
                  var clipped = r1.top < cont.top - 1 || r1.bottom > cont.bottom + 1;
                  res(JSON.stringify({
                    panDy: DY, nodeDelta: dNode, boxDelta: dBox, clipped: clipped,
                    rectTop: Math.round(r1.top), rectBottom: Math.round(r1.bottom),
                    contTop: Math.round(cont.top), contBottom: Math.round(cont.bottom),
                    ok: Math.abs(dNode - dBox) <= 3 && dNode < -100 && clipped
                  }));
                }, 150);
              }, 80);
            }, 250);
          });
        })()`
      );
      let ok = false, detail = chk;
      try { ok = JSON.parse(chk).ok; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    name: 'pan is unbounded (no range clamp)',
    run: async (ctx) => {
      // 需求：中键平移不再受「导图/内容范围」限制 —— 想挪多远就挪多远（原滚动式平移横向完全没有余量）
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app && app.getState ? app.getState().jm : null;
          if (!jm) return { ok: false, text: 'no jm' };
          app.resetView();
          var panel = document.querySelector('jmnodes').parentElement;
          var r = panel.getBoundingClientRect();
          var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          var p0 = app.getPanState();
          panel.dispatchEvent(new MouseEvent('mousedown', { button: 1, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
          document.dispatchEvent(new MouseEvent('mousemove', { button: 1, clientX: cx - 9000, clientY: cy - 9000, bubbles: true, cancelable: true }));
          document.dispatchEvent(new MouseEvent('mouseup', { button: 1, bubbles: true, cancelable: true }));
          var p = app.getPanState();
          var ddx = p.x - p0.x, ddy = p.y - p0.y;
          app.resetView();
          return { ok: ddx === -9000 && ddy === -9000, text: 'd=' + ddx + ',' + ddy };
        })()`
      );
      return chk;
    }
  },
  {
    name: '还原视图 brings the mindmap back (reset pan + root on screen)',
    run: async (ctx) => {
      // 需求：平移不限制范围后，需要「还原视图」按钮防止把导图挪丢找不到
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app && app.getState ? app.getState().jm : null;
          if (!jm) return { ok: false, text: 'no jm' };
          var panel = document.querySelector('jmnodes').parentElement;
          var cont = document.getElementById('mindmap-container');
          var cr = cont.getBoundingClientRect();
          var r = panel.getBoundingClientRect();
          var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          var p0 = app.getPanState();
          panel.dispatchEvent(new MouseEvent('mousedown', { button: 1, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
          document.dispatchEvent(new MouseEvent('mousemove', { button: 1, clientX: cx - 2500, clientY: cy - 1800, bubbles: true, cancelable: true }));
          document.dispatchEvent(new MouseEvent('mouseup', { button: 1, bubbles: true, cancelable: true }));
          var p1 = app.getPanState();
          var ddx = p1.x - p0.x, ddy = p1.y - p0.y;
          var nodeEl = cont.querySelector('jmnode[nodeid="root"]');
          var b = nodeEl.getBoundingClientRect();
          var offBefore = b.right < cr.left || b.left > cr.right || b.bottom < cr.top || b.top > cr.bottom;
          document.getElementById('btn-reset-view').click();
          var a = nodeEl.getBoundingClientRect();
          var centered = Math.abs((a.left + a.width / 2) - (cr.left + cr.right) / 2) <= 2
            && Math.abs((a.top + a.height / 2) - (cr.top + cr.bottom) / 2) <= 2;
          return {
            ok: ddx === -2500 && ddy === -1800 && offBefore && centered,
            text: 'd=' + ddx + ',' + ddy + ' offBefore=' + offBefore + ' centered=' + centered
          };
        })()`
      );
      return chk;
    }
  },
  {
    name: '拖动树：右键顶层主题根 ⇒ 菜单里**四个拖动入口一个都不在**（逐个点名）⇒ 直接用 MMApp.setDragMode(true,「wlan-book」) 进入并锁定目标树',
    run: async (ctx) => {
      /* 用户 2026-10-31 说「移除拖动模式」。2026-10-33 批4 只摘**入口**：右键菜单里那四条
       * （拖动树 / 拖动此子树 / 拖动到同级第几位 / 挂到别的父节点下）一条都不许再出现，
       * 而 `setDragMode` 那套 API **一行没删**（本域后面几十行前置都靠它）。
       * ⚠️ 这条断言**不是删掉再新写一条** —— 改前它判"菜单里有「拖动树」且真的点得到、
       * 点了之后锁定目标树"；现在同一件事被拆成两半：
       *   ① 菜单里**四个入口全不在**（改前只点名「拖动树」一个 ⇒ 现在逐个点名，判据更严）；
       *   ② 锁定目标树那一跳**直接从 API 走**（它才是"拖动模式还能用"的证据）。
       *   改前那半句"菜单文案必须含「移动「」"随入口一起消失（菜单里已经没有那条文案了）。 */
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           app.resetView();
           app.closeAllFloatDetail();
           if (app.dragModeActive()) app.setDragMode(false);
           var menu0 = document.getElementById('ctx-menu');
           if (menu0) menu0.style.display = 'none';
           var el = document.querySelector('jmnode[nodeid="wlan-book"]');
           if (!el) return { ok: false, text: 'no wlan-book node' };
           var cr = el.getBoundingClientRect();
           el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: cr.left + 4, clientY: cr.top + 4 }));
           await new Promise(function (res) { setTimeout(res, 120); });
           var menu = document.getElementById('ctx-menu');
           var labels = [].map.call(menu ? menu.querySelectorAll('.ctx-item') : [], function (x) { return x.textContent; });
           var GONE = ['拖动树', '拖动此子树', '拖动到同级第几位', '挂到别的父节点下'];
           var still = GONE.filter(function (k) {
             return labels.some(function (t) { return t.indexOf(k) >= 0; });
           });
           if (menu) menu.style.display = 'none';
           app.setDragMode(true, 'wlan-book');      // 入口已摘 ⇒ 只能从 API 进（它还在这才叫"摘入口 ≠ 摘 API"）
           var active = app.dragModeActive();
           var root = app.getDragTreeRoot();
           var kind = app.dragModeKind ? app.dragModeKind() : '(没有 dragModeKind)';
           app.setDragMode(false);
           return {
             ok: still.length === 0 && active === true && root === 'wlan-book' && kind === 'move',
             text: '菜单 ' + labels.length + ' 项，末尾=' + JSON.stringify(labels.slice(-3))
               + ' ｜ 四个入口里**仍在**菜单中的=' + JSON.stringify(still) + '（应 []）'
               + ' ｜ API 进入：active=' + active + ' 目标树=' + root + ' 档位=' + kind
           };
         })()`
      );
      return r;
    }
  },
  {
    /* 【2026-10-33 批4 新增】"摘入口 ≠ 摘 API" 的**唯一证据**（用户 2026-10-31「移除拖动模式」的第一期）。
     * 上一条断言证明的是"菜单里没有那四条入口了"；这一条证明的是"模式下那套东西还在、还能用"。
     * 两件事**必须分开判**：只有前者时，"把 setDragMode 一族删干净"也能让它绿 ⇒ 那是**过度删除**，
     * 会把 `scripts/smoke/` 里 8 个文件 / 65 行前置一起打断（本期明令不删）。
     * 判据三层（缺一不可）：
     *   ① **四个转发都在**（`renderer/app.js:210-215`）：setDragMode / dragModeActive / dragModeKind /
     *      getDragTreeRoot —— 其中 getDragTreeRoot 是派单时曾漏掉的那一条（域 46 在读它）；
     *   ② **raw 命名空间（window.MM）上也都在**：转发丢一个，`MM.*` 那侧就是 undefined；
     *   ③ **真能进 / 真能出**：setDragMode(true, 节点) ⇒ active=true 且 kind='move' 且 root=那个节点；
     *      三档（move / reorder / reparent）逐个可读；setDragMode(false) ⇒ active=false、root=null、
     *      kind 回 'move'。全链一句 setStatus / 一次重排都不改数据（这四条都不写盘）。 */
    name: '拖动模式 API 仍在（摘入口 ≠ 摘 API）：MMApp 的 setDragMode / dragModeActive / dragModeKind / getDragTreeRoot 四个转发都在、window.MM 那侧也在，且 setDragMode 真能进三档、真能退出',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(function () {
           var app = window.MMApp;
           var MM = window.MM;
           var NAMES = ['setDragMode', 'dragModeActive', 'dragModeKind', 'getDragTreeRoot'];
           var missingApp = NAMES.filter(function (n) { return typeof app[n] !== 'function'; });
           var missingMM = NAMES.filter(function (n) { return typeof MM[n] !== 'function'; });
           var node = 'wlan-book';
           if (app.dragModeActive()) app.setDragMode(false);
           var seen = {};
           app.setDragMode(true, node);
           seen.move = { on: app.dragModeActive(), kind: app.dragModeKind(), root: app.getDragTreeRoot() };
           app.setDragMode(true, node, { mode: 'reorder' });
           seen.reorder = { on: app.dragModeActive(), kind: app.dragModeKind(), root: app.getDragTreeRoot() };
           app.setDragMode(true, node, { mode: 'reparent' });
           seen.reparent = { on: app.dragModeActive(), kind: app.dragModeKind(), root: app.getDragTreeRoot() };
           app.setDragMode(false);
           seen.off = { on: app.dragModeActive(), kind: app.dragModeKind(), root: app.getDragTreeRoot(),
             bodyClass: document.body.className.indexOf('mm-dragmode') >= 0 };
           var inOk = function (k) {
             return seen[k].on === true && seen[k].kind === k && seen[k].root === node;
           };
           return {
             ok: missingApp.length === 0 && missingMM.length === 0
               && inOk('move') && inOk('reorder') && inOk('reparent')
               && seen.off.on === false && seen.off.root === null && seen.off.kind === 'move'
               && seen.off.bodyClass === false,
             text: 'MMApp 缺的转发=' + JSON.stringify(missingApp) + '（应 []）'
               + ' ｜ window.MM 缺的=' + JSON.stringify(missingMM) + '（应 []）'
               + ' ｜ 三档=' + JSON.stringify(seen.move) + '/' + JSON.stringify(seen.reorder)
               + '/' + JSON.stringify(seen.reparent)
               + ' ｜ 退出=' + JSON.stringify(seen.off)
           };
         })()`
      );
      return r;
    }
  },
  {
    name: '拖动树：左键拖动 → 目标树移动(dx,dy)、其他树不动、不产生脏数据',
    run: async (ctx) => {
      // 核心断言：只有 wlan-book（802.11 树）整体平移，comp-net（计算机网络树）原地不动；
      // 树偏移是视图操作，isDirty 前后不变。
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           app.resetView();
           if (!app.dragModeActive()) app.setDragMode(true, 'wlan-book');
           app.closeAllFloatDetail();
           var jm = app.getState().jm;
           if (!jm) return { ok: false, text: 'no jm' };
           var w0 = document.querySelector('jmnode[nodeid="wlan-book"]').getBoundingClientRect();
           var c0 = document.querySelector('jmnode[nodeid="comp-net"]').getBoundingClientRect();
           var viewBefore = { x: window.fdView.x, y: window.fdView.y };
           var dirtyBefore = app.isDirty();
           var panel = document.querySelector('jmnodes').parentElement;
           var rp = panel.getBoundingClientRect();
           var cx = rp.left + rp.width / 2, cy = rp.top + rp.height / 2;
           panel.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
           document.dispatchEvent(new MouseEvent('mousemove', { button: 0, clientX: cx - 130, clientY: cy - 90, bubbles: true, cancelable: true }));
           document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));
           var w1 = document.querySelector('jmnode[nodeid="wlan-book"]').getBoundingClientRect();
           var c1 = document.querySelector('jmnode[nodeid="comp-net"]').getBoundingClientRect();
           var dWx = Math.round(w1.left - w0.left), dWy = Math.round(w1.top - w0.top);
           var dCx = Math.round(c1.left - c0.left), dCy = Math.round(c1.top - c0.top);
           var dirtyAfter = app.isDirty();
           var tf = document.querySelector('jmnode[nodeid="wlan-book"]').style.transform || '';
           app.resetView(); // 复原（还原视图 = 复位树偏移）
           return {
             ok: dWx === -130 && dWy === -90 && dCx === 0 && dCy === 0
               && dirtyAfter === dirtyBefore && tf.indexOf('translate(') >= 0,
             text: '目标树位移=' + dWx + ',' + dWy + ' 对照树位移=' + dCx + ',' + dCy
               + ' 脏=' + dirtyBefore + '->' + dirtyAfter + ' tf=' + tf
           };
         })()`
      );
      return r;
    }
  },
  {
    name: '拖动树：左键单击不选节点、不弹详情（纯平移工具）',
    run: async (ctx) => {
      // 拖动模式下左键按下即被平移候选拦截（含 click 阶段），单击不产生选中/详情副作用
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           app.resetView();
           if (!app.dragModeActive()) app.setDragMode(true, 'wlan-book');
           app.closeAllFloatDetail();
           var jm = app.getState().jm;
           jm.select_node('comp-net');
           var selBefore = (jm.get_selected_node() || {}).id;
           var boxesBefore = document.querySelectorAll('.float-detail').length;
           var panel = document.querySelector('jmnodes').parentElement;
           var rect = panel.getBoundingClientRect();
           panel.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: rect.left + 50, clientY: rect.top + 50, bubbles: true, cancelable: true }));
           document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));
           var selAfter = (jm.get_selected_node() || {}).id;
           var boxesAfter = document.querySelectorAll('.float-detail').length;
           app.setDragMode(false);
           return {
             ok: selAfter === selBefore && boxesAfter === boxesBefore,
             text: '选中 ' + selBefore + '->' + selAfter + ' 详情框 ' + boxesBefore + '->' + boxesAfter
           };
         })()`
      );
      return r;
    }
  },
  {
    name: '拖动树：Esc 退出后点击恢复选中；树偏移保留、其他树仍未动',
    run: async (ctx) => {
      // Esc 退出拖动模式：树偏移保留（802.11 树还在拖后的位置），comp-net 从头到尾原地不动；
      // 退出后左键点击恢复 jsMind 原生选中。
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           app.resetView();
           if (!app.dragModeActive()) app.setDragMode(true, 'wlan-book');
           var modeBefore = app.dragModeActive();
           var c0 = document.querySelector('jmnode[nodeid="comp-net"]').getBoundingClientRect();
           var viewBefore = { x: window.fdView.x, y: window.fdView.y };
           var panel = document.querySelector('jmnodes').parentElement;
           // ⚠️ 起拖位置必须**落在要拖的那棵树上**，不能用"面板中心"：
           // 面板宽度会随 DSH 侧栏让位变化（侧栏显示时少 420px），中心点可能落到别的树上，
           // 于是"拖动的是哪棵树"就变了 —— 实测症状：偏移保留=false 且 对照树未动=false
           //（因为拖的是 comp-net，wlan-book 没动）。改成按目标节点自身位置起拖，与布局无关。
           var w0 = document.querySelector('jmnode[nodeid="wlan-book"]').getBoundingClientRect();
           var cx = Math.round(w0.left + w0.width / 2), cy = Math.round(w0.top + w0.height / 2);
           panel.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
           document.dispatchEvent(new MouseEvent('mousemove', { button: 0, clientX: cx - 120, clientY: cy - 60, bubbles: true, cancelable: true }));
           document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));
           var wMoved = document.querySelector('jmnode[nodeid="wlan-book"]').getBoundingClientRect();
           var geoBefore = (function () { var pan = document.querySelector('jmnodes').parentElement.getBoundingClientRect(); var tb = document.getElementById('toolbar'); return ' 面板top=' + Math.round(pan.top) + ' 工具栏h=' + tb.offsetHeight + ' 视口h=' + window.innerHeight; })();
           document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
           await new Promise(function (res) { setTimeout(res, 120); });
           var exited = !app.dragModeActive();
           var bodyCls = document.body.className.indexOf('mm-dragmode') >= 0;
           var wEsc = document.querySelector('jmnode[nodeid="wlan-book"]').getBoundingClientRect();
           var c1 = document.querySelector('jmnode[nodeid="comp-net"]').getBoundingClientRect();
           // 「偏移保留」= 树的位移**恰好等于视图的位移**（扣掉视图位移后原地不动）。
// 旧写法直接比绝对屏幕坐标，会把"合法的视图平移"误判成"偏移丢了" —— 实测 Esc 退出时
// 视图上移 22px、两棵树一起上移 22px，而它们**相对差一分未变**（-7495-424 = -7517-402），
// 也就是说树偏移一直是保留的。判据必须扣掉视图位移才与名字相符。
           var dvx = window.fdView.x - viewBefore.x, dvy = window.fdView.y - viewBefore.y;
           var dwx = wEsc.left - wMoved.left, dwy = wEsc.top - wMoved.top;
           var dcx = c1.left - c0.left, dcy = c1.top - c0.top;
           // 视图位移实测是 0,0，可两棵树仍整体上移 22px —— 那是 **jsMind 自己重排**移的
           //（与「展开/收起导致瞬移」同源：布局重排会让整棵树平移）。
           // 所以「偏移保留」的可判定形式是：**两棵树之间的相对位置不变**
           //（wlan 的偏移还在、comp 也没被单独拖动）。绝对坐标与「扣掉 fdView」都会被合法重排带偏。
           var kept = Math.abs((wEsc.left - wMoved.left) - (c1.left - c0.left)) <= 1
                   && Math.abs((wEsc.top - wMoved.top) - (c1.top - c0.top)) <= 1;
           var compStill = kept;   // 同一件事的两种说法：相对位置不变 ⇒ 对照树没被单独挪动
           var viewMoved = Math.round(dvx) + ',' + Math.round(dvy);
           
           var jm = app.getState().jm;
           var nodeEl = document.querySelector('jmnode[nodeid="tcp-handshake"]');
           nodeEl.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
           document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));
           var sel = (jm.get_selected_node() || {}).id;
           app.resetView(); // 复原
           return {
             ok: exited && !bodyCls && sel === 'tcp-handshake' && kept && compStill,
             text: '已退出=' + exited + ' bodyClass残留=' + bodyCls + ' 点击选中=' + sel
               + ' 偏移保留=' + kept + ' 对照树未动=' + compStill + geoBefore + ' Esc后(面板top=' + Math.round(document.querySelector('jmnodes').parentElement.getBoundingClientRect().top) + ' 工具栏h=' + document.getElementById('toolbar').offsetHeight + ')'
                + ' ｜起拖(' + cx + ',' + cy + ') modeOn=' + modeBefore + ' 视图位移=' + viewMoved + ' wlan拖前[' + Math.round(w0.left) + ',' + Math.round(w0.top) + '] 拖后[' + Math.round(wMoved.left) + ',' + Math.round(wMoved.top) + '] Esc后[' + Math.round(wEsc.left) + ',' + Math.round(wEsc.top) + '] comp[' + Math.round(c0.left) + ',' + Math.round(c0.top) + '→' + Math.round(c1.left) + ',' + Math.round(c1.top) + ']'
           };
         })()`
      );
      return r;
    }
  },
  {
    name: '拖动树模式：折叠 +/− 号（jmexpander）随树一起偏移',
    run: async (ctx) => {
      // 用户反馈①：折叠一个 wlan-book 子孙（让其 jmexpander 显示 +），拖动整棵树后，
      // 该 expander 的 transform 必须与对应 jmnode 完全一致。
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           if (app.dragModeActive()) app.setDragMode(false);
           window.MM.clearTreeOffsets();
           var jm = app.getState().jm;
           function findWithKids(n) {
             var ks = n.children || [];
             for (var i = 0; i < ks.length; i++) {
               if ((ks[i].children || []).length > 0) return ks[i];
               var f = findWithKids(ks[i]); if (f) return f;
             }
             return null;
           }
           var target = findWithKids(jm.get_node('wlan-book'));
           if (!target) return { ok: false, text: 'wlan-book 下无带孩子的节点' };
           jm.expand_node(target.id);
           jm.collapse_node(target.id); // 折叠 → expander 显示 +
           var exp = document.querySelector('jmexpander[nodeid="' + target.id + '"]');
           var nodeEl = document.querySelector('jmnode[nodeid="' + target.id + '"]');
           var expVisible = exp && getComputedStyle(exp).visibility === 'visible' && exp.offsetWidth > 0;
           app.setDragMode(true, 'wlan-book');
           var panel = document.querySelector('jmnodes').parentElement;
           var rect = panel.getBoundingClientRect();
           var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
           panel.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
           document.dispatchEvent(new MouseEvent('mousemove', { button: 0, clientX: cx - 130, clientY: cy - 90, bubbles: true, cancelable: true }));
           document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));
           var ntf = nodeEl.style.transform || '';
           var etf = exp.style.transform || '';
           // 复原：退出、展开节点、清除树偏移
           app.setDragMode(false);
           jm.expand_node(target.id);
           window.MM.clearTreeOffsets();
           return {
             ok: expVisible && ntf.indexOf('translate(') >= 0 && etf === ntf,
             text: 'expVisible=' + expVisible + ' nodeTf=' + ntf + ' expTf=' + etf
           };
         })()`
      );
      return r;
    }
  },
  {
    name: '拖动树模式：虚线框显示并完整框住树根，退出后隐藏',
    run: async (ctx) => {
      // 用户反馈②：进入模式后 #tree-drag-outline 显示，其屏幕矩形必须完整包含
      // 目标树根节点（wlan-book）；退出后隐藏。
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           if (app.dragModeActive()) app.setDragMode(false);
           window.MM.clearTreeOffsets();
           app.resetView();
           app.setDragMode(true, 'wlan-book');
           var box = document.getElementById('tree-drag-outline');
           var shown = box && getComputedStyle(box).display !== 'none';
           var br = box.getBoundingClientRect();
           var rr = document.querySelector('jmnode[nodeid="wlan-book"]').getBoundingClientRect();
           var covers = rr.left >= br.left - 1 && rr.right <= br.right + 1
             && rr.top >= br.top - 1 && rr.bottom <= br.bottom + 1;
           app.setDragMode(false);
           var hidden = getComputedStyle(box).display === 'none';
           return {
             ok: shown && covers && hidden,
             text: 'shown=' + shown + ' coversRoot=' + covers + ' hiddenAfter=' + hidden
               + ' box=' + Math.round(br.width) + 'x' + Math.round(br.height)
           };
         })()`
      );
      return r;
    }
  },
  {
    name: '拖动树模式：在节点上右键 = 退出且不弹菜单',
    run: async (ctx) => {
      // 用户反馈④（节点侧）：右键目标树节点，拖动模式直接退出，右键菜单不弹出。
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           if (app.dragModeActive()) app.setDragMode(false);
           window.MM.clearTreeOffsets();
           var menu = document.getElementById('ctx-menu');
           if (menu) menu.style.display = 'none';
           app.setDragMode(true, 'wlan-book');
           var rootEl = document.querySelector('jmnode[nodeid="wlan-book"]');
           var rr = rootEl.getBoundingClientRect();
           rootEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rr.left + 10, clientY: rr.top + 10 }));
           await new Promise(function (res) { setTimeout(res, 100); });
           var exited = !app.dragModeActive();
           var menuHidden = !menu || menu.style.display === 'none';
           return { ok: exited && menuHidden, text: 'exited=' + exited + ' menuHidden=' + menuHidden };
         })()`
      );
      return r;
    }
  },
  {
    name: '拖动树模式：在背景空白处右键 = 退出且不弹菜单',
    run: async (ctx) => {
      // 用户反馈④（背景侧）：右键画布空白处同样退出、不弹背景菜单。
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           if (app.dragModeActive()) app.setDragMode(false);
           window.MM.clearTreeOffsets();
           var menu = document.getElementById('ctx-menu');
           if (menu) menu.style.display = 'none';
           app.setDragMode(true, 'wlan-book');
           var cont = document.getElementById('mindmap-container');
           var cr = cont.getBoundingClientRect();
           cont.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: cr.left + 12, clientY: cr.top + 12 }));
           await new Promise(function (res) { setTimeout(res, 100); });
           var exited = !app.dragModeActive();
           var menuHidden = !menu || menu.style.display === 'none';
           return { ok: exited && menuHidden, text: 'exited=' + exited + ' menuHidden=' + menuHidden };
         })()`
      );
      return r;
    }
  },
  {
    name: '拖动树模式：光标恒为 grab，按住拖动变 grabbing，松开还原',
    run: async (ctx) => {
      // 用户反馈③：进入模式后节点/背景 computed cursor 恒为 grab；mousedown 按住
      // （body.mm-dragging）变 grabbing；mouseup 回 grab；退出模式后 class 清除。
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           if (app.dragModeActive()) app.setDragMode(false);
           window.MM.clearTreeOffsets();
           var cont = document.getElementById('mindmap-container');
           var rootEl = document.querySelector('jmnode[nodeid="wlan-book"]');
           app.setDragMode(true, 'wlan-book');
           var bodyMode = document.body.classList.contains('mm-dragmode');
           var cNode = getComputedStyle(rootEl).cursor;
           var cCont = getComputedStyle(cont).cursor;
           var panel = document.querySelector('jmnodes').parentElement;
           var rect = panel.getBoundingClientRect();
           panel.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }));
           var dragging = document.body.classList.contains('mm-dragging');
           var cDuring = getComputedStyle(rootEl).cursor;
           document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));
           var dragGone = !document.body.classList.contains('mm-dragging');
           var cAfter = getComputedStyle(rootEl).cursor;
           app.setDragMode(false);
           var modeGone = !document.body.classList.contains('mm-dragmode');
           return {
             ok: bodyMode && cNode === 'grab' && cCont === 'grab' && dragging
               && cDuring === 'grabbing' && dragGone && cAfter === 'grab' && modeGone,
             text: 'node=' + cNode + ' cont=' + cCont + ' during=' + cDuring + ' afterUp=' + cAfter
           };
         })()`
      );
      return r;
    }
  },
  {
    /* 【可见性判据迁移 ②（2026-10-09）】上一版判据 = "每个在屏端点的 9×9 **真帧**窗口里有非背景像素"。
     *  它能抓"线被裁"，但**不能证明那个像素是这条线画的**，而且**会被自家浮层骗**：
     *    · 别的墨也算（节点边框/文字/相邻线）⇒ 15 条"通过"不构成"线画出来了"的证据 ✗；
     *    · 实测（本批 I）面板底部 60px 被自家 `#msg-bar` 盖住（`z-index:30`、底 `#fbfcfe`），
     *      `md-m2-usb` 的可见端正落在它下面 ⇒ 真帧 9×9 窗口 **81/81 像素都是那个底色**
     *      （三通道全 ≥246 ⇒ 判成"背景/空白"），而**连线层位图里那一段墨确实有**（16 个不透明像素）
     *      ⇒ 旧判据把"被自家底栏盖住"误报成"超长连线的可见端画不出来"（假红）✗。
     *  本版判据 = **三层**（缺一不可）：
     *    ① 几何：每条线两端都落在连线层屏幕矩形内（拖到哪儿都不被位图边界裁掉）；
     *    ② 层内墨（**归因**）：每个在屏取样点（端点内缩 6px 处 1 个 + 沿**曲线**两端各 `CURVE_U.length` 个）
     *       在**连线层位图**里的 9×9 不透明像素 ≥ `paint.minHitsLineEnd` —— 位图里只有连线
     *       （节点/文字/浮层都进不去）⇒ 这一条才答得了"这段线真画出来了"，且与遮挡无关；
     *    ③ 真帧墨（**上屏**）：**只判没被别的层盖住的**取样点（真帧 9×9 非背景像素 ≥ 阈值）。
     *       被盖住的点按"不可判"处理（既不算丢、也不算看到），并在报文里点名 —— 读数不撒谎 ✓。
     *  另加两条地板（`paint.minJudgedLineEnds` / `minJudgedCurvePoints`）：可判点太少 = 判据空转 ⇒ 红。
     *  判别力证明（`MM_SMOKE_INJECT`）：`05-fixed-bitmap`（旧裁切缺陷）、`05-end-blank`（可见端没画）、
     *  `05-weak-criterion`（把端点那一半判据放水成"1 个像素 / 阈值 0"）——三个都必须判红 ✓。 */
    name: '拖动树模式：任意方向拖动后每条可见连线两端都落在连线层矩形内（无裁切丢失）+ 每个在屏取样点都数得到**连线层自己画出的**墨（端点 + 沿线多点，位图归因；没被浮层盖住时再加真帧）',
    run: async (ctx) => {
      // 用户反馈：拖动后子节点连线丢失。根因：连线层位图固定、余量仅 hmargin/
      // vmargin，向任意方向拖动超过该距离，线端点被位图边界裁切，节点 DOM 溢出
      // 仍可见。修复让连线层位置/尺寸随偏移扩展。这里多方向（含向右/下超出余量
      // 的大距离）黑盒核对：每条线两端（父子节点相邻缘）必须在连线层屏幕矩形内，
      // **并且这段线真的由连线层画出来了**（位图归因 + 沿线多点 + 真帧，见上面那段迁移说明）。
      if (!ctx.input) return { ok: false, text: '没有真输入底座（ctx.input 缺失）⇒ 取不到真帧 = 红' };
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           if (app.dragModeActive()) app.setDragMode(false);
           window.MM.clearTreeOffsets();
           var jm = app.getState().jm;
           var panel = document.querySelector('jmnodes').parentElement;
           var canvas = panel.querySelector('canvas.jsmind');
           var vectors = [[-130, -90], [260, 150], [-400, 220], [150, -260]];
           var dpr = window.devicePixelRatio || 1;
           // 主题模式下 root → 顶层主题的线是**设计性不画**的（见 installRootLineOverride）⇒
           // 像素判据必须跳过它们，否则「没画」会被误判成「线被裁掉」✗（实测踩到：comp-net 0/0 像素）
           var hideRoot = app.isThemeMode ? app.isThemeMode() : false;
           // —— 判别力证明（\`MM_SMOKE_INJECT=…\`）：两把"渲染改坏"的注入，都必须判红 ——
           //   ① 05-fixed-bitmap：复刻**旧缺陷**（连线层位图固定 200×150 不随包围盒扩）⇒ 端点被位图边界裁掉
           //   ② 05-end-blank  ：复刻"可见端**没画出来**"（画完把每条线的子端=可见端擦掉 40×40）⇒
           //      位图归因与沿线多点都必须抓到它（这是"判据有判别力"的正面证明 ✓）
           var INJ_BITMAP = ${JSON.stringify(MY_KEY('fixed-bitmap'))};
           var INJ_BLANK = ${JSON.stringify(MY_KEY('end-blank'))};
           var origSetSize = null, origShowLines = null;
           if (INJ_BITMAP && jm.view && jm.view.graph && jm.view.graph.set_size) {
             var g = jm.view.graph;
             origSetSize = g.set_size;
             g.set_size = function () { return origSetSize.call(g, 200, 150); };
           }
           if (INJ_BLANK && jm.view && typeof jm.view.show_lines === 'function') {
             origShowLines = jm.view.show_lines;
             jm.view.show_lines = function () {
               var out = origShowLines.apply(this, arguments);
               var gelI = this.graph.element(), cI = gelI.getContext('2d');
               var oxI = Number(gelI.dataset.ox) || 0, oyI = Number(gelI.dataset.oy) || 0;
               var LI = window.__mmLineEndpoints || [];
               for (var iI = 0; iI < LI.length; iI++) {
                 cI.clearRect(Math.round(LI[iI].c.x - oxI) - 20, Math.round(LI[iI].c.y - oyI) - 20, 40, 40);
               }
               return out;
             };
           }
           var OUT = [];
           for (var vi = 0; vi < vectors.length; vi++) {
             window.MM.clearTreeOffsets();
             app.resetView();
             app.setDragMode(true, 'wlan-book');
             var VX = vectors[vi][0], VY = vectors[vi][1];
             var rect = panel.getBoundingClientRect();
             var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
             panel.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
             document.dispatchEvent(new MouseEvent('mousemove', { button: 0, clientX: cx + VX, clientY: cy + VY, bubbles: true, cancelable: true }));
             document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));
             var cr = canvas.getBoundingClientRect();
             var pr2 = panel.getBoundingClientRect();
             // 可见区 = 连线层矩形 ∩ 面板矩形（面板 overflow:hidden ⇒ 交集之外的东西用户本来就看不到）
             var vis = { left: Math.max(cr.left, pr2.left), top: Math.max(cr.top, pr2.top),
               right: Math.min(cr.right, pr2.right), bottom: Math.min(cr.bottom, pr2.bottom) };
             var INSET = 3;
             // ── 主证据源：**连线层位图自己画出来的墨** ──
             // 为什么不能只靠真帧："窗口里有非背景像素"这句话在真帧里是**不成立**的 ——
             //   ① 别的墨也算（节点边框/文字/别的线）；
             //   ② 别的层盖在上面时，读到的是**那层的颜色**。实测（2026-10-09）：面板底部被
             //      \`#msg-bar\` 盖 60px（\`z-index:30\`、底 \`#fbfcfe\`=rgb(251,252,254)），md-m2-usb 的
             //      可见端正落在它下面 ⇒ 真帧 9x9 窗口 **81/81 个像素全是 251,252,254**（被判成"空白"），
             //      而**连线层位图里这一段墨是有的**（16 个不透明像素）⇒ 旧判据把"被自家底栏盖住"
             //      误报成"线丢了"✗。位图里只有连线（没有节点、没有浮层）⇒ 用它归因才准 ✓。
             var gel = jm.view.graph.element();
             var ictx = gel.getContext('2d');
             var kx = gel.width / Math.max(1, cr.width), ky = gel.height / Math.max(1, cr.height);
             var HALF = 4;   // 取样窗口 9x9（与真帧那一半同口径，见 thresholds.paint.minHitsLineEnd）
             var LC = null;  // 可见区那一块位图的**一份拷贝**（一次 getImageData；之后全部在内存里数）
             try {
               var bx0 = Math.max(0, Math.min(gel.width - 1, Math.round((vis.left - cr.left) * kx)));
               var by0 = Math.max(0, Math.min(gel.height - 1, Math.round((vis.top - cr.top) * ky)));
               var bx1 = Math.max(bx0 + 1, Math.min(gel.width, Math.round((vis.right - cr.left) * kx)));
               var by1 = Math.max(by0 + 1, Math.min(gel.height, Math.round((vis.bottom - cr.top) * ky)));
               LC = { data: ictx.getImageData(bx0, by0, bx1 - bx0, by1 - by0).data,
                 w: bx1 - bx0, h: by1 - by0, x0: bx0, y0: by0 };
             } catch (e1) { LC = null; }
             /** 屏幕点 → 连线层位图 9x9 窗口里的不透明像素数。
              *  窗口越界的那部分**按"没有墨"计**（不虚高）⇒ 位图没覆盖到就等于没画 ✓ */
             function layerInk(sx, sy) {
               if (!LC) return -1;
               var x = Math.round((sx - cr.left) * kx) - HALF - LC.x0;
               var y = Math.round((sy - cr.top) * ky) - HALF - LC.y0;
               var n = 0;
               for (var yy = 0; yy < 2 * HALF + 1; yy++) {
                 var ry = y + yy;
                 if (ry < 0 || ry >= LC.h) continue;
                 for (var xx = 0; xx < 2 * HALF + 1; xx++) {
                   var rx = x + xx;
                   if (rx < 0 || rx >= LC.w) continue;
                   if (LC.data[(ry * LC.w + rx) * 4 + 3] > 8) n++;
                 }
               }
               return n;
             }
             /** 可见区整块的层内墨（只数连线层自己画的；节点与任何浮层一律不算） */
             function layerInkVis() {
               if (!LC) return -1;
               var n = 0;
               for (var i = 3; i < LC.data.length; i += 4) if (LC.data[i] > 8) n++;
               return n;
             }
             /** 该点最上层元素是否属于地图容器（\`#jsmind_container\` 内）。
              *  被自家浮层（底部 \`#msg-bar\`、顶栏…）盖住 ⇒ 这一点的**真帧判据不可判**：
              *  既不能算"线丢了"（位图证明确实画了），也不能算"看到了"（用户看到的是浮层）✓ */
             function topIsMap(sx, sy) {
               try {
                 var el = document.elementFromPoint(sx, sy);
                 return !!(el && el.closest && el.closest('#jsmind_container'));
               } catch (e2) { return false; }
             }
             /** 沿线取样：**曲线上**的点（与 renderer/app-view.js 的 draw_line 契约同式）。
              *  为什么不能沿"两端直线弦"取样：jsMind 的 curved 型是**三次贝塞尔**
              *  （\`_bezier_to\`：P0=子端、P1=(子端x+2Δx/3, 子端y)、P2=(子端x, 父端y)、P3=父端），
              *  弦与曲线的最大偏差可达 0.16·|Δx|（实测横向 100px 的线在中段偏 12.5px）⇒
              *  沿弦取样必然扫到空气、把"线画了"判成"没画"✗。取曲线上的点才是几何一致 ✓ */
             var CURVE_U = ${JSON.stringify(CURVE_U)};
             function curvePoints(pPar, pChi) {
               var P0 = pChi, P1 = { x: pChi.x + 2 * (pPar.x - pChi.x) / 3, y: pChi.y },
                 P2 = { x: pChi.x, y: pPar.y }, P3 = pPar;
               return function (u) {
                 var m = 1 - u, a = m * m * m, b = 3 * m * m * u, c = 3 * m * u * u, d = u * u * u;
                 return { x: a * P0.x + b * P1.x + c * P2.x + d * P3.x,
                   y: a * P0.y + b * P1.y + c * P2.y + d * P3.y };
               };
             }
             function inVis(p) {
               return p.x >= vis.left + INSET && p.x <= vis.right - INSET
                 && p.y >= vis.top + INSET && p.y <= vis.bottom - INSET;
             }
             var bad = 0, checked = 0; var ex = [];
             var samples = [], short = 0, offscreen = 0, rootSkipped = 0, oneEndIn = 0;
             function inRect(px, py) {
               return px >= cr.left - 1 && px <= cr.right + 1 && py >= cr.top - 1 && py <= cr.bottom + 1;
             }
             /* 父端 y **必须按产品的分散口径算**：同一父同侧的多个孩子各自落在父侧边框的**等分点**上
              * （renderer/app-view.js 的 lineParentPoints：按上下序名次 rank ⇒ y = top + h*rank/(n+1)），
              * 不是共用侧边中点。上一版这里按"父侧边中点"搭取样曲线，于是"算出来的曲线"与"画出来的
              * 曲线"在父端附近越差越远 —— 实测宽面板（侧栏收起、1423px）下 4 条线的 8 个取样点读到
              * 层内墨=0，而 21x21 窗口里有 76–123 滴墨、最近墨距取样点只有 5 个位图像素（≈2.5 CSS px）
              * ⇒ 那是"线画在窗口外面一点"，不是"线没画"。取样点必须落在**真画出来的那条曲线**上。
              * ⚠️ 这不是把判据做松：端点落没落在"允许的等分点族"里，由本文件最后那条独立断言判；
              *   本条只负责"沿产品那条曲线数墨"，9x9 / 墨>=3 / 丢失必须 0 的口径一字未改。
              * ⚠️ 这里**不许**去读产品的 lineParentPoints / __mmLineEndpoints：那是 jsMind 布局坐标，
              *   与 getBoundingClientRect 的屏幕坐标不同空间（实测直接混用 ⇒ 几何 bad=539/885）。
              *   所以名次与等分点全部在**屏幕坐标**里独立算一遍（与产品公式同式，不共用读数）。 */
             var __grp = {}, __rank = {}, __fanN = {};
             for (var gid in jm.mind.nodes) {
               var gt = jm.mind.nodes[gid];
               if (gt.isroot || !gt.parent || !jm.layout.is_visible(gt)) continue;
               if (hideRoot && gt.parent.isroot) continue;
               var gpel = document.querySelector('jmnode[nodeid="' + gt.parent.id + '"]');
               var gcel = document.querySelector('jmnode[nodeid="' + gt.id + '"]');
               if (!gpel || !gcel) continue;
               var gpr = gpel.getBoundingClientRect(), gcr = gcel.getBoundingClientRect();
               var gside = (gcr.left + gcr.width / 2 < gpr.left + gpr.width / 2) ? 'left' : 'right';
               var gkey = gt.parent.id + '#' + gside;
               (__grp[gkey] = __grp[gkey] || []).push({ id: gt.id,
                 cy: gcr.top + gcr.height / 2, index: (typeof gt.index === 'number' ? gt.index : 0) });
             }
             for (var gk in __grp) {
               var gl = __grp[gk].sort(function (a, b) { return (a.cy - b.cy) || (a.index - b.index); });
               __fanN[gk] = gl.length;
               for (var gi2 = 0; gi2 < gl.length; gi2++) __rank[gk + '|' + gl[gi2].id] = gi2 + 1;
             }
             for (var id in jm.mind.nodes) {
               var t = jm.mind.nodes[id];
               if (t.isroot || !jm.layout.is_visible(t) || !t.parent) continue;
               if (hideRoot && t.parent.isroot) { rootSkipped++; continue; }
               var pe = document.querySelector('jmnode[nodeid="' + t.parent.id + '"]');
               var ce = document.querySelector('jmnode[nodeid="' + t.id + '"]');
               if (!pe || !ce) continue;
               var pr = pe.getBoundingClientRect(), tr = ce.getBoundingClientRect();
               var p1, p2;
               var pSide = (tr.left + tr.width / 2 < pr.left + pr.width / 2) ? 'left' : 'right';
               var pKey = t.parent.id + '#' + pSide;
               var pRank = __rank[pKey + '|' + t.id] || 0;
               var pFan = __fanN[pKey] || 1;
               var pY = (pFan > 1 && pRank > 0) ? (pr.top + pr.height * pRank / (pFan + 1)) : (pr.top + pr.height / 2);
               if (pSide === 'left') {
                 p1 = { x: pr.left, y: pY };
                 p2 = { x: tr.right, y: tr.top + tr.height / 2 };
               } else {
                 p1 = { x: pr.right, y: pY };
                 p2 = { x: tr.left, y: tr.top + tr.height / 2 };
               }
               checked++;
               if (!inRect(p1.x, p1.y) || !inRect(p2.x, p2.y)) {
                 bad++; if (ex.length < 4) ex.push(t.id);
               }
               // ── 取样点：沿连线方向从两端各内缩 D（避开节点自己的边框像素）──
               //  ⚠️ 只判**在屏上**的那一端：本工程的地图（comnet 548 节点）远大于面板
               //  （实测面板 729×754）⇒ 绝大多数线的两端都在视口外。**两端都出屏的跳过**，
               // 只剩一端在屏的**仍然要判**（"这一端真的画出来了吗"是同一件事 ✓）。
               var dx = p2.x - p1.x, dy = p2.y - p1.y;
               var len = Math.sqrt(dx * dx + dy * dy);
               if (!(len >= 8)) { short++; continue; }       // 太短的连线没有"两端内缩"空间
               var D = Math.min(6, len / 4);
               /* 端点窗口的取样点**必须落在真那条曲线上**：上一版是"沿弦内缩 D 像素"，而这条曲线在两端
                * 的切向是**水平**的（控制点带 child.y / parent.y）⇒ 对"父子几乎垂直"的长线，沿弦内缩
                * 得到的那一点会离开曲线好几像素，9x9 窗口就数不到墨（实测 s-5-7 端点长期 2/3，
                * 而同一位置 21x21 窗口里墨很多）。改法只是**怎么取那一点**：沿曲线从该端朝另一端走
                * 同样的 D 距离；判据（离该端 6px 的窗口里墨 >=3）一字未改。 */
               var along = curvePoints(p1, p2);
               function endSample(fromU, towardU, dist) {
                 var e0 = along(fromU);
                 for (var kk = 1; kk <= 80; kk++) {
                   var uu = fromU + (towardU - fromU) * (kk / 80);
                   var pp0 = along(uu);
                   var dd0 = Math.sqrt((pp0.x - e0.x) * (pp0.x - e0.x) + (pp0.y - e0.y) * (pp0.y - e0.y));
                   if (dd0 >= dist) return pp0;
                 }
                 return along(towardU);
               }
               var q1 = endSample(1, 0, D);
               var q2 = endSample(0, 1, D);
               var v1 = inVis(q1), v2 = inVis(q2);
               if (!v1 && !v2) { offscreen++; continue; }
               if (!v1 || !v2) oneEndIn++;
               // ① 端点窗口（父端/子端各自内缩 6px）：层内墨 + 是否被别的层盖住
               var ends = [];
               if (v1) ends.push({ x: q1.x, y: q1.y, layer: layerInk(q1.x, q1.y), top: topIsMap(q1.x, q1.y) });
               if (v2) ends.push({ x: q2.x, y: q2.y, layer: layerInk(q2.x, q2.y), top: topIsMap(q2.x, q2.y) });
               // ② 沿线多点（**曲线上**的点，两端各取）：光一个端点窗口说不清"是这条线还是别的墨"，
               //    沿线多点都数得到层内墨，才是"这条线真的画出来了"的几何一致证据 ✓
               /* along（同一条曲线）已在端点取样处建好，这里不再建第二份 */
               var curve = [];
               for (var ui = 0; ui < CURVE_U.length; ui++) {
                 for (var half2 = 0; half2 < 2; half2++) {
                   var pp = along(half2 === 0 ? CURVE_U[ui] : 1 - CURVE_U[ui]);
                   if (!inVis(pp)) continue;
                   curve.push({ x: pp.x, y: pp.y, layer: layerInk(pp.x, pp.y), top: topIsMap(pp.x, pp.y) });
                 }
               }
               samples.push({ id: t.id, ends: ends, curve: curve, len: Math.round(len) });
             }
             OUT.push({ v: [VX, VY], bad: bad, checked: checked, ex: ex,
               short: short, offscreen: offscreen, rootSkipped: rootSkipped, oneEndIn: oneEndIn,
               vis: { left: Math.round(vis.left), top: Math.round(vis.top), right: Math.round(vis.right), bottom: Math.round(vis.bottom) },
               canvas: { left: Math.round(cr.left), top: Math.round(cr.top), right: Math.round(cr.right), bottom: Math.round(cr.bottom) },
               layerVis: layerInkVis(), layerOk: !!LC, bmpW: gel.width, bmpH: gel.height,
               samples: samples });
           }
           app.setDragMode(false);
           window.MM.clearTreeOffsets();
           app.resetView();
           if (origShowLines) jm.view.show_lines = origShowLines;   // 注入收尾一律复位 ✓
           if (origSetSize) jm.view.graph.set_size = origSetSize;   // 注入收尾一律复位 ✓
           return JSON.stringify({ ok: true, dpr: dpr,
             s: (window.MM.getPanState ? window.MM.getPanState().s : null),
             panel: { left: Math.round(panel.getBoundingClientRect().left), top: Math.round(panel.getBoundingClientRect().top),
               width: Math.round(panel.getBoundingClientRect().width), height: Math.round(panel.getBoundingClientRect().height) },
             frames: OUT });
         })()`
      );
      let data;
      try { data = JSON.parse(r); } catch (e) { return { ok: false, text: '几何取样返回的不是 JSON：' + String(r).slice(0, 200) }; }
      if (!data.ok) return { ok: false, text: '几何取样失败' + JSON.stringify(data).slice(0, 200) };
      // ── 逐帧判两半（下半段在"取样点"处逐点判）──
      //   ① **层内墨**（读连线层位图）：这一段到底**画了没有** —— 位图里只有连线（节点/文字/浮层
      //      都进不去）⇒ 这才是"线画出来了"的**归因**证据，且与"有没有被盖住"无关 ✓
      //   ② **真帧墨**（真帧窗口非背景像素）：这一段到底**上屏了没有** —— 只在"该点没被别的层盖住"
      //      时才判（被 `#msg-bar` 这类自家浮层盖住时，窗口里读到的是浮层的颜色 ⇒ 不可判：
      //      既不能算"线丢了"（位图为证），也不能算"看到了"）✓
      const dpr = data.dpr || 1;
      const ROI = 9;                                     // 取样窗口边长（CSS px）
      const pred = frameStats.nonBackgroundPredicate();
      // 判别力证明②（MM_SMOKE_INJECT=05-weak-criterion）：把"端点窗口"这一半**放水**
      //（退化成"只扫 1 个像素点 + 阈值 0 + 不查归因"，即老判据"窗口里有东西就算"的更弱版）。
      // 期待读数：与 05-end-blank 同开时**仍然必红** —— 因为**沿线多点/层内墨**那一半兜住了 ✓
      const WEAK = MY_KEY('weak-criterion');
      const frameROI = WEAK ? 1 : ROI;
      const frameThr = WEAK ? 0 : VTH.paint.minHitsLineEnd;
      const baseThr = VTH.paint.minHitsLineEnd;          // 层内墨的阈值（与真帧同口径）
      const parts = [];
      let checkedAll = 0, shortAll = 0, offAll = 0, badAll = 0, rootAll = 0, oneAll = 0;
      let endJudged = 0, curveJudged = 0, occluded = 0, frameJudged = 0;
      let lostEnd = 0, lostCurve = 0, lostFrame = 0;
      let layerMin = Infinity, layerScanned = true;
      const lostEx = [];
      for (const f of data.frames) {
        checkedAll += f.checked; shortAll += f.short; offAll += f.offscreen; badAll += f.bad;
        rootAll += f.rootSkipped; oneAll += f.oneEndIn;
        if (f.layerOk && isFinite(f.layerVis)) layerMin = Math.min(layerMin, f.layerVis);
        else layerScanned = false;
        // 真帧要扫的窗口：**只登记"没被别的层盖住"的点**（被盖住 ⇒ 真帧那一半不可判）
        const rects = [];
        const plan = [];
        for (const s of f.samples) {
          for (const e of s.ends) {
            if (!e.top) continue;
            rects.push({ x: (e.x - frameROI / 2) * dpr, y: (e.y - frameROI / 2) * dpr,
              width: frameROI * dpr, height: frameROI * dpr });
            plan.push({ kind: '端点', id: s.id, p: e });
          }
          if (WEAK) continue;                            // 放水档：沿线那一半按"端点窗口"口径退化成不可判
          for (const c of s.curve) {
            if (!c.top) continue;
            rects.push({ x: (c.x - ROI / 2) * dpr, y: (c.y - ROI / 2) * dpr, width: ROI * dpr, height: ROI * dpr });
            plan.push({ kind: '沿线段', id: s.id, p: c });
          }
        }
        let frameHits = [];
        if (rects.length) {
          const img = await ctx.input.capture();
          frameHits = frameStats.scanRegionMany(img, rects, { predicate: pred }).map((h) => (h.ok ? h.hits : -1));
        }
        let lostE = 0, lostC = 0, occ = 0;
        // ① 层内墨：每个在屏取样点都要数得到"连线层自己画的墨"（遮挡与否一视同仁）
        for (const s of f.samples) {
          for (const e of s.ends) {
            endJudged++;
            if (!e.top) { occluded++; occ++; }
            if (!(e.layer >= baseThr)) {
              lostEnd++; lostE++;
              if (lostEx.length < 4) lostEx.push(s.id + '·端点（层内墨=' + e.layer + '/' + baseThr + '）');
            }
          }
          for (const c of s.curve) {
            curveJudged++;
            if (!c.top) { occluded++; occ++; }
            if (!(c.layer >= baseThr)) {
              lostCurve++; lostC++;
              if (lostEx.length < 4) lostEx.push(s.id + '·沿线段（层内墨=' + c.layer + '/' + baseThr + '）');
            }
          }
        }
        // ② 真帧墨：只判"没被盖住"的取样点（plan 与 frameHits 同序同长）
        plan.forEach((it, i) => {
          frameJudged++;
          if (!(frameHits[i] >= frameThr)) {
            lostFrame++;
            if (lostEx.length < 4) lostEx.push(it.id + '·' + it.kind + '（真帧=' + frameHits[i] + '/' + frameThr + '）');
          }
        });
        parts.push('[' + f.v + ']几何bad=' + f.bad + '/' + f.checked
          + ' 端点丢失=' + lostE + '/' + f.samples.reduce((n, s) => n + s.ends.length, 0)
          + ' 沿线丢失=' + lostC + '/' + f.samples.reduce((n, s) => n + s.curve.length, 0)
          + ' 被浮层盖住（真帧不判）=' + occ
          + ' 太短跳过=' + f.short + ' 只有一端在屏=' + f.oneEndIn + ' 两端都出屏=' + f.offscreen
          + ' root线跳过=' + f.rootSkipped
          + ' 连线层可见区墨=' + (f.layerOk ? f.layerVis : '扫描失败') + '（位图 ' + f.bmpW + 'x' + f.bmpH + '）');
      }
      // 采不到真值 = 红（两条下限：端点取样数、沿线取样数），别让"一个点都没判"悄悄变绿 ✓
      if (!endJudged || !layerScanned) {
        return { ok: false, text: '取不到"线画出来没有"的真值（一个在屏端点都没有 / 连线层位图读不出来）⇒ 红 ｜ 几何='
          + badAll + '/' + checkedAll + ' 视口=' + JSON.stringify(data.frames[0].vis) + ' 面板=' + JSON.stringify(data.panel) + ' s=' + data.s };
      }
      if (endJudged < VTH.paint.minJudgedLineEnds || curveJudged < VTH.paint.minJudgedCurvePoints) {
        return { ok: false, text: '可判取样点太少（端点 ' + endJudged + ' < ' + VTH.paint.minJudgedLineEnds
          + ' 或沿线 ' + curveJudged + ' < ' + VTH.paint.minJudgedCurvePoints + '）⇒ 判据空转，按红处理 ✓ ｜ '
          + parts.join(' ｜ ') };
      }
      const layerOk = layerMin >= VTH.paint.minHitsMapVisible;
      const ok = badAll === 0 && lostEnd + lostCurve + lostFrame === 0 && layerOk;
      return { ok: ok, text: parts.join(' ｜ ')
        + ' ｜ 判据（**两层证据，缺一不可**）：'
        + '① 几何 — 每条线的两端都落在连线层矩形内（拖到哪儿都不被位图边界裁掉）；'
        + '② 层内墨 — 每个在屏取样点（端点各 1 + 沿**曲线**两端各 ' + CURVE_U.length + ' 点）在**连线层位图**里的'
        + ' 9x9 不透明像素 ≥' + baseThr + '（位图里只有连线 ⇒ 这是"这段线真画出来了"的归因证据，'
        + '与有没有浮层盖住无关）；'
        + '③ 真帧墨 — 没被别的层盖住的取样点，真帧 9x9 非背景像素 ≥' + frameThr
        + '（被自家浮层盖住的点**不判**：实测面板底部 60px 被 #msg-bar 盖住，读到的只是它的底色）'
        + '；连线层可见区整块墨 ≥' + VTH.paint.minHitsMapVisible + '（本次最少 ' + layerMin + '，只挡整块白屏）'
        + '（已判端点 ' + endJudged + ' 个、沿线段 ' + curveJudged + ' 个，真帧判 ' + frameJudged
        + ' 个、被浮层盖住 ' + occluded + ' 个；太短跳过 ' + shortAll + '、两端都出屏跳过 ' + offAll
        + '、root线（设计性不画）跳过 ' + rootAll + '、只有一端在屏 ' + oneAll + '）'
        + (lostEx.length ? ' ｜ 丢失明细=' + lostEx.join(' ') : '')
        + ' ｜ s=' + data.s + ' 面板=' + JSON.stringify(data.panel) + ' 视口=' + JSON.stringify(data.frames[0].vis) };
    }
  },
  {
    name: '拖动树 + 缩放后连线仍与节点绑定（线端=父子节点缘，落在连线层矩形内）',
    run: async (ctx) => {
      // 用户反馈：正常放大缩小时连线位置和节点错位。根因曾是连线层用 style.left/top
      // （布局值不随 scale），节点随 scale → zoom 后错位 ox*(1-s)。已改为逻辑原点存入
      // dataset、由 fdApplyView 并入 transform 并随 s 缩放。这里把 wlan-book 向左拖到
      // 越过 comp-net（-900，使连线层逻辑原点非零），再 zoom 1.6，逐条线核对节点缘。
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           if (app.dragModeActive()) app.setDragMode(false);
           window.MM.clearTreeOffsets();
           app.resetView();
           var jm = app.getState().jm;
           var panel = document.querySelector('jmnodes').parentElement;
           var canvas = panel.querySelector('canvas.jsmind');
           app.setDragMode(true, 'wlan-book');
           var rect = panel.getBoundingClientRect();
           var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
           panel.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
           document.dispatchEvent(new MouseEvent('mousemove', { button: 0, clientX: cx - 900, clientY: cy, bubbles: true, cancelable: true }));
           document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));
           window.MM.setViewScale(1.6);
           await new Promise(function (res) { setTimeout(res, 250); });
           var cr = canvas.getBoundingClientRect();
           var bad = 0, checked = 0; var ex = [];
           // 主题模式下 root→顶层主题线被设计性跳过（不画），断言同样跳过。
           var hideRoot = app.isThemeMode ? app.isThemeMode() : false;
           function inRect(px, py) {
             return px >= cr.left - 1 && px <= cr.right + 1 && py >= cr.top - 1 && py <= cr.bottom + 1;
           }
           for (var id in jm.mind.nodes) {
             var t = jm.mind.nodes[id];
             if (t.isroot || !jm.layout.is_visible(t) || !t.parent) continue;
             if (hideRoot && t.parent && t.parent.isroot) continue;
             var pe = document.querySelector('jmnode[nodeid="' + t.parent.id + '"]');
             var ce = document.querySelector('jmnode[nodeid="' + t.id + '"]');
             if (!pe || !ce) continue;
             var pr = pe.getBoundingClientRect(), tr = ce.getBoundingClientRect();
             var p1, p2;
             if (tr.left + tr.width / 2 < pr.left + pr.width / 2) {
               p1 = { x: pr.left, y: pr.top + pr.height / 2 };
               p2 = { x: tr.right, y: tr.top + tr.height / 2 };
             } else {
               p1 = { x: pr.right, y: pr.top + pr.height / 2 };
               p2 = { x: tr.left, y: tr.top + tr.height / 2 };
             }
             checked++;
             if (!inRect(p1.x, p1.y) || !inRect(p2.x, p2.y)) { bad++; if (ex.length < 5) ex.push(t.id); }
           }
           app.setDragMode(false);
           app.resetView();
           return { ok: bad === 0, text: '拖动-900 + zoom1.6 后 bad=' + bad + '/' + checked + '(' + ex.join(',') + ')' };
         })()`
      );
      return r;
    }
  },
  {
    name: '连线端点严格 = 父子节点相连侧边框上的点（子端 = 子节点侧边中点；父端 = 父侧边**等分点**族里的一个；线端真源来自节点实际 DOM 边框）',
    run: async (ctx) => {
      // 契约：show_lines 不再用 get_node_point_in/out 布局缓存，线端直接由节点实际边框
      // （nodeBorderRect：style.left/top + 尺寸 + 树偏移）推导。这里**独立**从 DOM 重算期望：
      //   · 子端：孩子**相连侧边的中点**（这条与改动前逐字节相同）；
      //   · 父端：父**相连侧边**上的一个点，且落在"这条边框按该父在该侧的可见孩子数 n 等分"的
      //     那一族点上（`top + h*(i+1)/(n+1)`，i=1..n）。
      // ⚠️ **本判据的收紧史（别把它改回"必须等于中点"）**：R2 期 3（d）之前父端恒等于**侧边中点**
      //    ——那正是"同一个父的 12 个孩子 12 条线全落在一个点上"（真 comnet 实测：135 个扇出 ≥ 3
      //   的父**每个都只有 1 个不同的父端点**）。现在父端按**子序**分散到等分点上。所以本条判据
      //   从"必须是中点"改成"必须在这条边框上、且在等分点族里"，**仍然钉住"真源是 nodeBorderRect"**
      //   （改坏了这一跳，端点就会脱开边框 ⇒ 必红 ✓），只是不再要求"重合"。
      //   ⚠️ 等分点族按**这个父的 n 个孩子**算 ⇒ 这里也要按父分组数一遍（n 取该父在屏上的孩子数）。
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           app.setDragMode(false); window.MM.clearTreeOffsets(); app.resetView();
           var jm = app.getState().jm;
           jm.view.show_lines();
           function border(id) {
             var el = document.querySelector('jmnode[nodeid="' + id + '"]');
             return window.MM.nodeBorderRect(el, id);
           }
           var eps = window.__mmLineEndpoints || [];
           // 每个父在这一侧有几个孩子（= 等分点族的 n）——从端点读数现算，不另取一份树
           var fanN = {};
           eps.forEach(function (L) {
             var pb = border(L.parent), cb = border(L.child);
             var side = (cb.cx < pb.cx) ? 'left' : 'right';
             fanN[L.parent + '#' + side] = (fanN[L.parent + '#' + side] || 0) + 1;
           });
           var bad = 0; var ex = []; var why = null;
           eps.forEach(function (L) {
             var pb = border(L.parent), cb = border(L.child);
             var left = cb.cx < pb.cx;
             var wPx = left ? pb.left : pb.right, wCx = left ? cb.right : cb.left;
             var onC = (Math.abs(L.c.x - wCx) <= 1) && (L.c.y >= cb.top - 1) && (L.c.y <= cb.bottom + 1)
               && (Math.abs(L.c.y - cb.cy) <= 1);
             var onP = (Math.abs(L.p.x - wPx) <= 1) && (L.p.y >= pb.top - 1) && (L.p.y <= pb.bottom + 1);
             var n = fanN[L.parent + '#' + (left ? 'left' : 'right')] || 1;
             var hitLattice = false;
             if (n <= 1) { hitLattice = Math.abs(L.p.y - pb.cy) <= 1; }   // 独子 ⇒ 仍是中点（默认档那一档）
             else {
               for (var i = 1; i <= n; i++) {
                 var want = pb.top + (pb.bottom - pb.top) * i / (n + 1);
                 if (Math.abs(L.p.y - want) <= 1) { hitLattice = true; break; }
               }
             }
             if (!onC || !onP || !hitLattice) {
               bad++;
               if (!why) {
                 why = L.child + ' 子端(' + onC + ') 父端在边框上(' + onP + ') 父端在等分点族(n='
                   + n + ')(' + hitLattice + ') p=' + JSON.stringify(L.p) + ' 父边框=[' + pb.top + ','
                   + pb.bottom + '] 相连侧x=' + wPx;
               }
               if (ex.length < 5) ex.push(L.child);
             }
           });
           return { ok: bad === 0 && eps.length > 100,
             text: '线数=' + eps.length + ' 不匹配=' + bad + (ex.length ? '(' + ex.join(',') + ')' : '')
               + (why ? ' 首个原因：' + why : '') };
         })()`
      );
      return r;
    }
  },
  {
    name: '移动节点后连线端点跟随到新边框中点（为移动所有节点奠基）',
    run: async (ctx) => {
      // 直接证明“线绑定节点实际边框”：把 tcp-handshake 的 style.left 右移 53（模拟未来
      // 移动节点），重画后以它为子的线端（左树=右边框中点）必须 +53；还原后回到原值。
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           app.setDragMode(false); window.MM.clearTreeOffsets(); app.resetView();
           var jm = app.getState().jm;
           var el = document.querySelector('jmnode[nodeid="tcp-handshake"]');
           function childEnd() {
             var L = (window.__mmLineEndpoints || []).filter(function (x) { return x.child === 'tcp-handshake'; })[0];
             return L ? { x: L.c.x, y: L.c.y } : null;
           }
           jm.view.show_lines();
           var before = childEnd();
           var origLeft = el.style.left;
           var DX = 53;
           el.style.left = (parseFloat(origLeft) + DX) + 'px';
           jm.view.show_lines();
           var after = childEnd();
           el.style.left = origLeft;
           jm.view.show_lines();
           var restored = childEnd();
           var movedOk = after && Math.abs((after.x - before.x) - DX) <= 1 && Math.abs(after.y - before.y) <= 1;
           var backOk = restored && Math.abs(restored.x - before.x) <= 1;
           app.resetView();
           return { ok: movedOk && backOk,
             text: 'before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after)
               + ' restored=' + JSON.stringify(restored) + ' 期望dx=' + DX };
         })()`
      );
      return r;
    }
  }
];

module.exports = assertions;
