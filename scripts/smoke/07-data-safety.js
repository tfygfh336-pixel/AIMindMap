/* ============================================================
 * scripts/smoke/07-data-safety.js —— 冒烟断言分域 07：数据安全、保存链路与隔离
 * （保存校验闸门 / 撤销重做 / 工具栏 MD 按钮下线 / 附件卡片 / 读文件 IPC /
 *   中键平移 transform / 监听器泄漏回归 / 冒烟项目副本隔离）
 *
 * 由入口 scripts/smoke-assertions.js 按顺序拼接执行。
 * 本文件是对拆分前单体 smoke-assertions.js 的逐字搬运，勿改断言文案与顺序。
 * ============================================================ */
'use strict';

const assertions = [
  {
    name: 'save validation gate (bad data rejected)',
    run: async (ctx) => {
      // 数据安全闸门：project:save 写盘前必须校验，坏数据（缺 meta）应被拒绝
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var st = app && app.getState ? app.getState() : null;
          if (!st || !st.project) return { ok: false, text: 'no project loaded' };
          var bad = { format: 'node_tree', data: { id: 'root', topic: 'bad' } };
          return window.desktop.project.save(st.project.file, bad)
            .then(function () { return { ok: false, text: 'BAD DATA SAVED — gate missing' }; })
            .catch(function (err) {
              var msg = (err && err.message) || String(err);
              return { ok: msg.indexOf('validation failed') >= 0, text: 'rejected: ' + msg.slice(0, 100) };
            });
        })()`
      );
      return chk;
    }
  },
  {
    name: 'undo/redo roundtrip',
    run: async (ctx) => {
      // 快照式撤销重做：走 MMApp 历史栈，加节点 → undo 恢复 → redo 再现
      // 注意：undo/redo 会重建 jsMind 实例，每步必须实时取 jm
      const chk = await ctx.exec(
        `(function () {
          try {
            var app = window.MMApp;
            var st = app.getState();
            var h = st.history;
            var jm0 = st.jm;
            jm0.add_node('tcp-handshake', 'smoke-undo', 'smoke-undo', {});
            h.push(JSON.stringify(app.serializeTree())); // 修改后压入快照（recordHistory 语义）
            app.save();
            app.undo();                    // 撤销 add → 重建 jsMind
            var jm1 = app.getState().jm;
            var undone = !jm1.get_node('smoke-undo');
            app.redo();                    // 重做 add → 重建 jsMind
            var jm2 = app.getState().jm;
            var redone = !!jm2.get_node('smoke-undo');
            var jm3 = app.getState().jm;
            jm3.remove_node('smoke-undo');
            app.save();
            return {
              ok: undone && redone,
              text: 'undone=' + undone + ' redone=' + redone + ' histDepth=' + h.depth
            };
          } catch (e) { return { ok: false, text: 'err:' + e.message }; }
        })()`
      );
      return chk;
    }
  },
  {
    name: 'toolbar md buttons removed',
    run: async (ctx) => {
      // v0.16：导入/导出 MD 只保留文件菜单入口，工具栏按钮必须消失
      const chk = await ctx.exec(
        `(function () {
          return 'import=' + !!document.getElementById('btn-import-md') + ' export=' + !!document.getElementById('btn-export-md');
        })()`
      );
      return { ok: /import=false export=false/.test(chk), text: chk };
    }
  },
  {
    name: 'attachment cards in detail (in-memory)',
    run: async (ctx) => {
      // 附件区渲染：给节点临时挂 files（内存态）→ showDetail → 断言文件卡片出现，随后还原
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app && app.getState ? app.getState().jm : null;
          if (!jm) return { ok: false, text: 'no jm' };
          var n = jm.get_node('tcp-handshake');
          if (!n) return { ok: false, text: 'no node' };
          var orig = (n.data.files || []).slice();
          n.data.files = [
            { file: 'attachments/rfc793.pdf', caption: 'RFC 793 原文' },
            { file: 'attachments/note.md', caption: '阅读笔记' }
          ];
          app.showDetail(n);
          var fc = document.querySelector('.float-detail .fd-files-content');
          var cards = fc ? fc.querySelectorAll('.file-card') : [];
          var title = fc ? fc.querySelector('.files-title') : null;
          var cardOk = cards.length === 2 && !!title && title.textContent.indexOf('附件') >= 0;
          n.data.files = orig;
          app.showDetail(n);
          return { ok: cardOk, text: 'cards=' + cards.length + ' title=' + (title ? title.textContent.trim() : 'none') };
        })()`
      );
      return chk;
    }
  },
  {
    name: 'read-file IPC works (md preview path)',
    run: async (ctx) => {
      // md 附件预览依赖主进程读文件（fetch(file://) 被 Chromium 禁）；验证 IPC 链路
      const chk = await ctx.exec(
        `(function () {
          var p = window.MMApp.getState().project;
          if (!p || !p.file) return { ok: false, text: 'no project' };
          var base = p.file.replace(/[\\\\/][^\\\\/]+$/, '');
          // 读项目 JSON 自身（与附件同目录层级），验证 主进程读文件→渲染层 链路
          return window.desktop.app.readFile(p.file)
            .then(function (r) {
              return { ok: !!(r && r.ok) && r.text.indexOf('node_tree') >= 0, text: 'ok=' + (r && r.ok) + ' len=' + (r && r.text ? r.text.length : 0) };
            })
            .catch(function (err) { return { ok: false, text: 'err:' + (err && err.message || err) }; });
        })()`
      );
      return chk;
    }
  },
  {
    name: 'middle-drag pans canvas (transform, unbounded)',
    run: async (ctx) => {
      // v0.16：鼠标中键拖动 → 用 transform 平移整个导图视口（不再走滚动，故不受滚动范围限制）
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app && app.getState ? app.getState().jm : null;
          if (!jm) return { ok: false, text: 'no jm' };
          var panel = document.querySelector('jmnodes').parentElement;
          jm.expand_to_depth(20);
          var p0 = app.getPanState();
          var r = panel.getBoundingClientRect();
          panel.dispatchEvent(new MouseEvent('mousedown', { button: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
          document.dispatchEvent(new MouseEvent('mousemove', { button: 1, clientX: r.left + r.width / 2 - 130, clientY: r.top + r.height / 2 - 90, bubbles: true, cancelable: true }));
          document.dispatchEvent(new MouseEvent('mouseup', { button: 1, bubbles: true, cancelable: true }));
          var p1 = app.getPanState();
          var dx = p1.x - p0.x, dy = p1.y - p0.y;
          var tf = (document.querySelector('jmnodes').style.transform || '');
          app.resetView();
          var hasT = tf.indexOf('translate(') >= 0 && tf.indexOf('scale(') >= 0;
          return { ok: dx === -130 && dy === -90 && hasT, text: 'd=' + dx + ',' + dy + ' transform=' + tf };
        })()`
      );
      return chk;
    }
  },
  {
    name: '重复重建不累积监听/观察者（泄漏回归）',
    run: async (ctx) => {
      // 历史 bug：renderMind 内联注册 container click / window resize / MutationObserver，
      // 而 renderMind 每次 undo/redo、切换项目都会执行 → 监听与观察者无限累积
      // （全工程 59 个 addEventListener 对 0 个 removeEventListener），
      // 表现为点击一次触发 N 次 showDetail、内存持续增长。
      // 本断言包裹注册 API 计数，连续重建若干次后要求：长期监听只注册 0 次，存活观察者 ≤ 1。
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          if (!app || !app.getState().jm) return { ok: false, text: 'no jm' };
          var realAdd = EventTarget.prototype.addEventListener;
          var realMO = window.MutationObserver;
          var c = { containerClick: 0, windowResize: 0, created: 0, live: 0 };
          EventTarget.prototype.addEventListener = function (type, fn, opts) {
            try {
              if (type === 'click' && this && this.id === 'mindmap-container') c.containerClick++;
              if (type === 'resize' && this === window) c.windowResize++;
            } catch (e) {}
            return realAdd.call(this, type, fn, opts);
          };
          window.MutationObserver = function (cb) {
            c.created++;
            var inst = new realMO(cb);
            var ro = inst.observe.bind(inst), rd = inst.disconnect.bind(inst), living = false;
            inst.observe = function () { if (!living) { living = true; c.live++; } return ro.apply(null, arguments); };
            inst.disconnect = function () { if (living) { living = false; c.live--; } return rd(); };
            return inst;
          };
          var restore = function () { EventTarget.prototype.addEventListener = realAdd; window.MutationObserver = realMO; };
          var N = 4, p = Promise.resolve();
          for (var i = 0; i < N; i++) p = p.then(function () { return app.openProject('comnet'); });
          return p.then(function () {
            restore();
            var ok = c.containerClick === 0 && c.windowResize === 0 && c.live <= 1;
            return { ok: ok, text: '重建' + N + '次 新增containerClick=' + c.containerClick
              + ' windowResize=' + c.windowResize + ' observer创建=' + c.created + ' 存活=' + c.live };
          }).catch(function (e) { restore(); return { ok: false, text: 'err:' + (e && e.message || e) }; });
        })()`
      );
      return chk;
    }
  },
  {
    name: '冒烟运行在隔离的项目副本上（不写真实数据）',
    run: async (ctx) => {
      // 数据安全不变量：冒烟断言里有真正写盘的操作（undo/redo 回合断言会 app.save()），
      // 历史实现直接在**真实项目**上跑 —— 内容虽最终复原，但每次 verify 都重写用户数据，
      // 且中途崩溃会在真实笔记里永久留下测试节点（实测 comnet.json mtime 每次冒烟都变）。
      // 现由 main.js 在 --smoke 时把项目根重定向到 os.tmpdir 下的临时副本。
      // 本断言守住该不变量：一旦有人去掉隔离，路径里就不再含沙箱标记，立即变红。
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var st = app && app.getState ? app.getState() : null;
          var file = st && st.project && st.project.file;
          if (!file) return { ok: false, text: 'no project file' };
          var isolated = file.indexOf('ai-mind-map-smoke-') >= 0;
          return { ok: isolated, text: '项目文件=' + file + ' 隔离开关=' + isolated };
        })()`
      );
      return chk;
    }
  }
];

module.exports = assertions;
