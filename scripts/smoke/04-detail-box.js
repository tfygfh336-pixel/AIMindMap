/* ============================================================
 * scripts/smoke/04-detail-box.js —— 冒烟断言分域 04：浮动详情框的布局与锁定
 * （拖动改位 / 小锁随平移不变 / 小锁跨缩放偏移不变 / 大锁忽略平移 /
 *   多框共存 / 拖动自动上锁 / 详情框随缩放等比 / 悬停提示 / 区块顺序）
 *
 * 由入口 scripts/smoke-assertions.js 按顺序拼接执行。
 * 本文件是对拆分前单体 smoke-assertions.js 的逐字搬运，勿改断言文案与顺序。
 * ============================================================ */
'use strict';

const assertions = [
  {
    name: 'float detail draggable (header drag moves it)',
    run: async (ctx) => {
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app.getState().jm;
          if (!jm) return Promise.resolve(JSON.stringify({ ok: false, reason: 'no jm' }));
          app.closeAllFloatDetail(); app.showDetail(jm.get_node('tcp-handshake'));
          return new Promise(function (res) {
            setTimeout(function () {
              setLock('screen');
              var fd = document.querySelector('.float-detail');
              fd.style.left = '50px'; fd.style.top = '50px';
              var head = fd.querySelector('.fd-head');
              head.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 200, clientY: 200 }));
              document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 260, clientY: 235 }));
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
              var st = app.getFloatDetailState();
              res(JSON.stringify({ from: '50,50', to: st.left + ',' + st.top, ok: st.left === 110 && st.top === 85 }));
            }, 60);
          });
          function setLock(mode) {
            var boxEl = document.querySelector('.float-detail'); var btn = boxEl.querySelector(mode === 'map' ? '.fd-lock-map' : '.fd-lock-screen');
            for (var i = 0; i < 3; i++) {
              if (window.MMApp.getFloatDetailState().lock === mode) break;
              btn.click();
            }
          }
        })()`
      );
      let ok = false, detail = chk;
      try { ok = JSON.parse(chk).ok; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    name: '小锁 keeps detail at fixed offset from its node (pan)',
    run: async (ctx) => {
      // 需求：小锁 = 详情框相对导图锁死。判据：平移时详情框与**所属节点框**同步位移
      //      （相对位置不变）—— 即"节点框在 (0,0)、详情也锁在那，就一直在那"。
      // 注意：必须先把 scrollTop 归零再设目标值，否则会撞上滚动上界 → 变成"假平移"。
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app.getState().jm;
          if (!jm) return Promise.resolve(JSON.stringify({ ok: false, reason: 'no jm' }));
          app.closeAllFloatDetail();
          jm.expand_to_depth(20);
          window.MM.setViewScale(1);
          app.showDetail(jm.get_node('tcp-handshake'));
          return new Promise(function (res) {
            setTimeout(function () {
              document.querySelector('.float-detail').querySelector('.fd-lock-map').click();
              var panel = document.querySelector('jmnodes').parentElement;
              var node = document.querySelector('jmnode[nodeid="tcp-handshake"]');
              var box = document.querySelector('.float-detail');
              setTimeout(function () {
                var n0 = node.getBoundingClientRect(), b0 = box.getBoundingClientRect();
                var pr = panel.getBoundingClientRect();
                var cx = pr.left + pr.width / 2, cy = pr.top + pr.height / 2, DY = -300;
                panel.dispatchEvent(new MouseEvent('mousedown', { button: 1, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
                document.dispatchEvent(new MouseEvent('mousemove', { button: 1, clientX: cx, clientY: cy + DY, bubbles: true, cancelable: true }));
                document.dispatchEvent(new MouseEvent('mouseup', { button: 1, bubbles: true, cancelable: true }));
                setTimeout(function () {
                  app.positionFloatDetail(); // 显式驱动一次定位
                  var n1 = node.getBoundingClientRect(), b1 = box.getBoundingClientRect();
                  var dNode = Math.round(n1.top - n0.top), dBox = Math.round(b1.top - b0.top);
                  res(JSON.stringify({
                    panDy: DY, nodeDelta: dNode, boxDelta: dBox,
                    lock: app.getFloatDetailState().lock,
                    ok: Math.abs(dNode - dBox) <= 3 && Math.abs(dNode - DY) <= 3
                  }));
                }, 120);
              }, 80);
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
    name: '小锁 keeps detail glued to its node across zoom (offset invariant)',
    run: async (ctx) => {
      // 需求：小锁 = 详情框相对**所属节点框**的位置被锁死。
      // 判据：以「节点框左上角」为原点，详情框偏移量（换算成节点自身坐标，即除以缩放）
      //      在缩放前后必须不变 —— 这就是"节点框在 (0,0)、详情也锁在那，就一直在那"。
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp; var jm = app.getState().jm;
          if (!jm) return Promise.resolve(JSON.stringify({ ok: false, reason: 'no jm' }));
          app.closeAllFloatDetail();
          window.MM.setViewScale(1);
          app.showDetail(jm.get_node('tcp-handshake'));
          return new Promise(function (res) {
            setTimeout(function () {
              var box = document.querySelector('.float-detail');
              box.querySelector('.fd-lock-map').click();
              var node = document.querySelector('jmnode[nodeid="tcp-handshake"]');
              function off() {
                var b = box.getBoundingClientRect(), n = node.getBoundingClientRect();
                var S = jm.view.zoom_current || 1;
                return { x: (b.left - n.left) / S, y: (b.top - n.top) / S };
              }
              var o0 = off();
              window.MM.setViewScale(1.5);
              app.positionFloatDetail();
              setTimeout(function () {
                var o1 = off();
                window.MM.setViewScale(1);
                app.positionFloatDetail();
                res(JSON.stringify({
                  lock: app.getFloatDetailState().lock,
                  offsetZoom1: Math.round(o0.x) + ',' + Math.round(o0.y),
                  offsetZoom1p5: Math.round(o1.x) + ',' + Math.round(o1.y),
                  drift: Math.round(o1.x - o0.x) + ',' + Math.round(o1.y - o0.y),
                  ok: Math.abs(o1.x - o0.x) <= 1.5 && Math.abs(o1.y - o0.y) <= 1.5
                }));
              }, 250);
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
    name: 'float detail lock-screen: ignores mindmap pan',
    run: async (ctx) => {
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app.getState().jm;
          if (!jm) return Promise.resolve(JSON.stringify({ ok: false, reason: 'no jm' }));
          app.closeAllFloatDetail();
          jm.expand_to_depth(20);
          window.MM.setViewScale(1);
          app.showDetail(jm.get_node('tcp-handshake'));
          return new Promise(function (res) {
            setTimeout(function () {
              document.querySelector('.float-detail').querySelector('.fd-lock-screen').click();
              var panel = document.querySelector('jmnodes').parentElement;
              var node = document.querySelector('jmnode[nodeid="tcp-handshake"]');
              var box = document.querySelector('.float-detail');
              setTimeout(function () {
                var n0 = node.getBoundingClientRect(), b0 = box.getBoundingClientRect();
                var pr = panel.getBoundingClientRect();
                var cx = pr.left + pr.width / 2, cy = pr.top + pr.height / 2, DY = -300;
                panel.dispatchEvent(new MouseEvent('mousedown', { button: 1, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
                document.dispatchEvent(new MouseEvent('mousemove', { button: 1, clientX: cx, clientY: cy + DY, bubbles: true, cancelable: true }));
                document.dispatchEvent(new MouseEvent('mouseup', { button: 1, bubbles: true, cancelable: true }));
                setTimeout(function () {
                  var n1 = node.getBoundingClientRect(), b1 = box.getBoundingClientRect();
                  var dNode = Math.round(n1.top - n0.top), dBox = Math.round(b1.top - b0.top);
                  // 契约：导图确实平移了（节点位移 ≈ DY），但大锁框纹丝不动（位移 = 0）
                  res(JSON.stringify({
                    panDy: DY, nodeDelta: dNode, boxDelta: dBox,
                    lock: app.getFloatDetailState().lock,
                    ok: Math.abs(dNode - DY) <= 3 && dBox === 0 && app.getFloatDetailState().lock === 'screen'
                  }));
                }, 120);
              }, 80);
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
    name: 'locked detail boxes accumulate (multi-box coexist)',
    run: async (ctx) => {
      // 需求2：未锁定的框被复用；已上锁（小锁/屏幕锁）的框保留不被覆盖 → 可同时展示多个详情框，
      //        且每个新框出现在「节点框的下面」。
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app.getState().jm;
          if (!jm) return Promise.resolve(JSON.stringify({ ok: false, reason: 'no jm' }));
          app.closeAllFloatDetail();
          app.showDetail(jm.get_node('tcp-handshake'));
          return new Promise(function (res) {
            setTimeout(function () {
              document.querySelector('.float-detail').querySelector('.fd-lock-map').click(); // 给第 1 个框上小锁
              app.showDetail(jm.get_node('dns'));                                            // 应另开第 2 个框
              setTimeout(function () {
                var els = document.querySelectorAll('.float-detail');
                var st = app.getFloatDetailState();
                var titles = [];
                for (var i = 0; i < els.length; i++) titles.push(els[i].querySelector('.fd-title').textContent);
                var box2 = els[els.length - 1];
                var n2 = document.querySelector('jmnode[nodeid="dns"]');
                var fr = box2.getBoundingClientRect(), nr = n2.getBoundingClientRect();
                res(JSON.stringify({
                  boxes: st.boxes, locks: st.locks, titles: titles.join(' | '),
                  newBoxBelowNode: fr.top >= nr.bottom - 1,
                  ok: st.boxes === 2 && st.locks[0] === 'map' && st.locks[1] === 'follow'
                    && titles[0].indexOf('TCP 连接管理') >= 0 && titles[1].indexOf('DNS') >= 0
                    && fr.top >= nr.bottom - 1
                }));
              }, 200);
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
    name: 'dragging a detail box auto-applies 小锁 (map lock)',
    run: async (ctx) => {
      // 需求3：一旦被拖动，就自动上小锁（基于其在导图中的位置锁定）
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app.getState().jm;
          if (!jm) return Promise.resolve(JSON.stringify({ ok: false, reason: 'no jm' }));
          app.closeAllFloatDetail();
          app.showDetail(jm.get_node('tcp-handshake'));
          return new Promise(function (res) {
            setTimeout(function () {
              var before = app.getFloatDetailState();
              var fd = document.querySelector('.float-detail');
              fd.style.left = '60px'; fd.style.top = '60px';
              var head = fd.querySelector('.fd-head');
              head.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 200, clientY: 200 }));
              document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 250, clientY: 240 }));
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
              var after = app.getFloatDetailState();
              res(JSON.stringify({
                lockBefore: before.lock, lockAfter: after.lock, left: after.left, top: after.top,
                ok: before.lock === 'follow' && after.lock === 'map'
                  && Math.abs(after.left - 110) <= 1 && Math.abs(after.top - 100) <= 1
              }));
            }, 120);
          });
        })()`
      );
      let ok = false, detail = chk;
      try { ok = JSON.parse(chk).ok; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    name: 'detail box scales with mindmap zoom (fixed ratio to node box)',
    run: async (ctx) => {
      // 需求1：详情框尺寸与节点框保持固定比例 —— 随导图缩放同步缩放（transform: scale(zoom)）
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app.getState().jm;
          if (!jm) return Promise.resolve(JSON.stringify({ ok: false, reason: 'no jm' }));
          app.closeAllFloatDetail();
          window.MM.setViewScale(1);
          app.showDetail(jm.get_node('tcp-handshake'));
          return new Promise(function (res) {
            setTimeout(function () {
              var fd = document.querySelector('.float-detail');
              var w1 = fd.getBoundingClientRect().width;
              var t1 = fd.style.transform || '(none)';
              window.MM.setViewScale(1.5);
              app.positionFloatDetail();
              setTimeout(function () {
                var w15 = fd.getBoundingClientRect().width;
                var t15 = fd.style.transform || '(none)';
                window.MM.setViewScale(1);
                app.positionFloatDetail();
                res(JSON.stringify({
                  widthZoom1: Math.round(w1), widthZoom1p5: Math.round(w15),
                  ratio: Math.round(w15 / w1 * 100) / 100, transform: t1 + ' -> ' + t15,
                  ok: w1 > 0 && Math.abs(w15 / w1 - 1.5) <= 0.05
                }));
              }, 200);
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
    name: 'detail image hover shows 双击浏览 tip near cursor',
    run: async (ctx) => {
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app.getState().jm;
          if (!jm) return Promise.resolve(JSON.stringify({ ok: false, reason: 'no jm' }));
          app.closeAllFloatDetail(); app.showDetail(jm.get_node('tcp-handshake'));
          return new Promise(function (res) {
            setTimeout(function () {
              var img = document.querySelector('.float-detail .fd-images-content img[data-full]');
              if (!img) return res(JSON.stringify({ ok: false, reason: 'no image in detail' }));
              img.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: true, clientX: 400, clientY: 300 }));
              img.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 420, clientY: 340 }));
              var tip = document.getElementById('fd-img-tip');
              var shown = tip.style.display === 'block';
              var text = tip.textContent;
              var left = parseFloat(tip.style.left), top = parseFloat(tip.style.top);
              img.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, cancelable: true }));
              var hiddenAfterLeave = document.getElementById('fd-img-tip').style.display === 'none';
              res(JSON.stringify({
                shown: shown, text: text, left: left, top: top, hiddenAfterLeave: hiddenAfterLeave,
                ok: shown && text === '双击浏览' && left === 434 && top === 356 && hiddenAfterLeave
              }));
            }, 60);
          });
        })()`
      );
      let ok = false, detail = chk;
      try { ok = JSON.parse(chk).ok; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    name: 'detail renders images above 相关知识点区',
    run: async (ctx) => {
      const chk = await ctx.exec(
        `(function () {
          var imgs = document.querySelector('.float-detail .fd-images-content');
          var bl = document.querySelector('.float-detail .fd-related');
          if (!imgs || !bl) return JSON.stringify({ ok: false, reason: 'missing sections' });
          var pos = imgs.compareDocumentPosition(bl);
          return JSON.stringify({
            imagesBeforeBacklinks: !!(pos & 4),
            ok: !!(pos & 4)
          });
        })()`
      );
      let ok = false, detail = chk;
      try { ok = JSON.parse(chk).ok; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    // 锁住一次**删除**（防止被误加回来）：图片区曾同时列出节点声明的 links，
    // 渲染成「🔗 跳转到 <项目>/<id>」并一律调 switchProject()。但 switchProject 开头是
    // `name === state.project.name → return`，于是**同项目链接点了毫无反应** ——
    // 实测 comnet 的 47 条链接全是本项目内，即 47 个死链接。
    // 关系展示现已完全交给「相关知识点」（区分同项目/跨项目、带方向与标题）。
    name: '图片区只放图片：不再出现「🔗 跳转到」这类死链接行',
    run: async (ctx) => {
      const chk = await ctx.exec(
        `(function () {
           var app = window.MMApp;
           var jm = app.getState().jm;
           // 选一个有 links 的节点（comnet 的 overview 声明了多条本项目内链接）
           var id = null;
           var all = jm.mind.nodes ? Object.keys(jm.mind.nodes) : [];
           for (var i = 0; i < all.length; i++) {
             var n = jm.get_node(all[i]);
             if (n && n.data && (n.data.links || []).length) { id = all[i]; break; }
           }
           if (!id) return JSON.stringify({ ok: true, text: '本项目无带 links 的节点（跳过）' });
           app.showDetail(jm.get_node(id));
           var ic = document.querySelector('.float-detail .fd-images-content');
           if (!ic) return JSON.stringify({ ok: false, text: 'no images section' });
           var dead = ic.querySelectorAll('a[data-link-project]').length;
           var jump = ic.innerHTML.indexOf('跳转到') >= 0;
           return JSON.stringify({
             ok: dead === 0 && !jump,
             text: '节点=' + id + ' 死链接数=' + dead + ' 含「跳转到」字样=' + jump,
             __node: id
           });
         })()`
      );
      let ok = false, detail = chk;
      try { const o = JSON.parse(chk); ok = o.ok; detail = o.text; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    // 与「点相关知识点条目」同一根因的第二个表现：`.img-remove` 的处理函数里会
    // renderFdBox() 重建 innerHTML → 被点的按钮当场脱离 DOM → 事件冒泡到容器时
    // `e.target.closest('.float-detail')` 返回 null → 被误判为"点了空白" → 关掉整个详情框。
    // 即"点移除该图，图没了、框也没了"。修复用 composedPath() 取派发当时的路径。
    name: '详情框：点「移除该图」不会把整个详情框一起关掉',
    run: async (ctx) => {
      const chk = await ctx.exec(
        `(function () {
           var app = window.MMApp;
           var jm = app.getState().jm;
           // 找一个带图片的节点
           var all = jm.mind.nodes ? Object.keys(jm.mind.nodes) : [];
           var id = null;
           for (var i = 0; i < all.length; i++) {
             var n = jm.get_node(all[i]);
             if (n && n.data && (n.data.images || []).length) { id = all[i]; break; }
           }
           if (!id) return JSON.stringify({ ok: true, text: '本项目无带图片节点（跳过）' });
           app.showDetail(jm.get_node(id));
           var before = app.getFloatDetailState();
           if (!before.visible) return JSON.stringify({ ok: false, text: '详情框未打开' });
           var btn = document.querySelector('.float-detail .fd-images-content .img-remove');
           if (!btn) return JSON.stringify({ ok: false, text: '未找到移除按钮' });
           btn.click();
           var after = app.getFloatDetailState();
           var boxes = after.boxes || 0;
           var anyVisible = false;
           for (var k = 0; k < boxes; k++) { if (app.getFloatDetailState(k).visible) anyVisible = true; }
           return JSON.stringify({
             ok: boxes > 0 && anyVisible,
             text: '节点=' + id + ' 点击前可见=' + before.visible
                 + ' 点击后框数=' + boxes + ' 仍有可见框=' + anyVisible
           });
         })()`
      );
      let ok = false, detail = chk;
      try { const o = JSON.parse(chk); ok = o.ok; detail = o.text; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  }
];

module.exports = assertions;
