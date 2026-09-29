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
    name: '拖动树：右键顶层主题根 → 菜单含「拖动树」→ 点击进入并锁定目标树',
    run: async (ctx) => {
      // v0.15：右键菜单「拖动树」锁定 nodeId 所在**顶层主题树**（comnet 中 wlan-book =
      // 「802.11 无线网络」）为拖动目标；进入后左键拖动 = 只移动这棵树。
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
           var hit = labels.filter(function (t) { return t.indexOf('拖动树') >= 0; });
           if (!hit.length) return { ok: false, text: '菜单无「拖动树」项: ' + JSON.stringify(labels) };
           var item = [].filter.call(menu.querySelectorAll('.ctx-item'), function (x) { return x.textContent.indexOf('拖动树') >= 0; })[0];
           item.click();
           await new Promise(function (res) { setTimeout(res, 120); });
           var active = app.dragModeActive();
           var root = app.getDragTreeRoot();
           return {
             ok: active && root === 'wlan-book' && /移动「/.test(hit[0]),
             text: '菜单项=' + hit[0] + ' 已进入=' + active + ' 目标树=' + root
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
           var c0 = document.querySelector('jmnode[nodeid="comp-net"]').getBoundingClientRect();
           var panel = document.querySelector('jmnodes').parentElement;
           var rect = panel.getBoundingClientRect();
           var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
           panel.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
           document.dispatchEvent(new MouseEvent('mousemove', { button: 0, clientX: cx - 120, clientY: cy - 60, bubbles: true, cancelable: true }));
           document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));
           var wMoved = document.querySelector('jmnode[nodeid="wlan-book"]').getBoundingClientRect();
           document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
           await new Promise(function (res) { setTimeout(res, 120); });
           var exited = !app.dragModeActive();
           var bodyCls = document.body.className.indexOf('mm-dragmode') >= 0;
           var wEsc = document.querySelector('jmnode[nodeid="wlan-book"]').getBoundingClientRect();
           var c1 = document.querySelector('jmnode[nodeid="comp-net"]').getBoundingClientRect();
           var kept = Math.abs(wEsc.left - wMoved.left) <= 1 && Math.abs(wEsc.top - wMoved.top) <= 1;
           var compStill = Math.abs(c1.left - c0.left) <= 1 && Math.abs(c1.top - c0.top) <= 1;
           var jm = app.getState().jm;
           var nodeEl = document.querySelector('jmnode[nodeid="tcp-handshake"]');
           nodeEl.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
           document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));
           var sel = (jm.get_selected_node() || {}).id;
           app.resetView(); // 复原
           return {
             ok: exited && !bodyCls && sel === 'tcp-handshake' && kept && compStill,
             text: '已退出=' + exited + ' bodyClass残留=' + bodyCls + ' 点击选中=' + sel
               + ' 偏移保留=' + kept + ' 对照树未动=' + compStill
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
    name: '拖动树模式：任意方向拖动后每条可见连线两端都落在连线层矩形内（无裁切丢失）',
    run: async (ctx) => {
      // 用户反馈：拖动后子节点连线丢失。根因：连线层位图固定、余量仅 hmargin/
      // vmargin，向任意方向拖动超过该距离，线端点被位图边界裁切，节点 DOM 溢出
      // 仍可见。修复让连线层位置/尺寸随偏移扩展。这里多方向（含向右/下超出余量
      // 的大距离）黑盒核对：每条线两端（父子节点相邻缘）必须在连线层屏幕矩形内。
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           if (app.dragModeActive()) app.setDragMode(false);
           window.MM.clearTreeOffsets();
           var jm = app.getState().jm;
           var panel = document.querySelector('jmnodes').parentElement;
           var canvas = panel.querySelector('canvas.jsmind');
           var vectors = [[-130, -90], [260, 150], [-400, 220], [150, -260]];
           var summary = [];
           var allOk = true;
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
             var bad = 0, checked = 0; var ex = [];
             function inRect(px, py) {
               return px >= cr.left - 1 && px <= cr.right + 1 && py >= cr.top - 1 && py <= cr.bottom + 1;
             }
             for (var id in jm.mind.nodes) {
               var t = jm.mind.nodes[id];
               if (t.isroot || !jm.layout.is_visible(t) || !t.parent) continue;
               var pe = document.querySelector('jmnode[nodeid="' + t.parent.id + '"]');
               var ce = document.querySelector('jmnode[nodeid="' + t.id + '"]');
               if (!pe || !ce) continue;
               var pr = pe.getBoundingClientRect(), tr = ce.getBoundingClientRect();
               var p1, p2;
               if (tr.left + tr.width / 2 < pr.left + pr.width / 2) { // 子在父左
                 p1 = { x: pr.left, y: pr.top + pr.height / 2 };
                 p2 = { x: tr.right, y: tr.top + tr.height / 2 };
               } else {
                 p1 = { x: pr.right, y: pr.top + pr.height / 2 };
                 p2 = { x: tr.left, y: tr.top + tr.height / 2 };
               }
               checked++;
               if (!inRect(p1.x, p1.y) || !inRect(p2.x, p2.y)) {
                 bad++; if (ex.length < 4) ex.push(t.id);
               }
             }
             if (bad) allOk = false;
             summary.push('[' + VX + ',' + VY + ']bad=' + bad + '/' + checked + (ex.length ? '(' + ex.join(',') + ')' : ''));
           }
           app.setDragMode(false);
           window.MM.clearTreeOffsets();
           app.resetView();
           return { ok: allOk, text: summary.join(' ') };
         })()`
      );
      return r;
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
    name: '连线端点严格 = 父子节点相邻侧边框中点（线端真源来自节点实际 DOM 边框）',
    run: async (ctx) => {
      // 契约：show_lines 不再用 get_node_point_in/out 布局缓存，线端直接由节点实际边框
      // （nodeBorderRect：style.left/top + 尺寸 + 树偏移）推导。这里独立从 DOM 重算期望
      // 边框中点，与 show_lines 暴露的 window.__mmLineEndpoints 逐条核对。
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
           var bad = 0; var ex = [];
           eps.forEach(function (L) {
             var pb = border(L.parent), cb = border(L.child);
             var ep, ec;
             if (cb.cx < pb.cx) { ep = { x: pb.left, y: pb.cy }; ec = { x: cb.right, y: cb.cy }; }
             else { ep = { x: pb.right, y: pb.cy }; ec = { x: cb.left, y: cb.cy }; }
             if (Math.abs(L.p.x - ep.x) > 1 || Math.abs(L.p.y - ep.y) > 1
               || Math.abs(L.c.x - ec.x) > 1 || Math.abs(L.c.y - ec.y) > 1) {
               bad++; if (ex.length < 5) ex.push(L.child);
             }
           });
           return { ok: bad === 0 && eps.length > 100,
             text: '线数=' + eps.length + ' 不匹配=' + bad + (ex.length ? '(' + ex.join(',') + ')' : '') };
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
