/* ============================================================
 * scripts/smoke/01-core.js —— 冒烟断言分域 01：核心加载与视图基线
 * （加载就绪 / 点击→浮动详情 / 详情定位 / 滚轮缩放 / 缩放范围 /
 *   单一 transform 缩放模型 / 单一 DOM 树 / 面板无滚动条）
 *
 * 由入口 scripts/smoke-assertions.js 按顺序拼接执行。
 * 本文件是对拆分前单体 smoke-assertions.js 的逐字搬运，勿改断言文案与顺序。
 * ============================================================ */
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const assertions = [
  {
    name: 'renderer loaded, jsMind ready (open comnet)',
    run: async (ctx) => {
      // 项目经 IPC 异步加载；冒烟断言全部基于 comnet 项目（tcp-handshake 节点），先强制切换
      await ctx.exec('window.MMApp.openProject("comnet")');
      let ok = false;
      for (let i = 0; i < 40; i++) {
        ok = await ctx.exec(
          'window.__mindReady === true && window.MMApp.getState().project && window.MMApp.getState().project.name === "comnet"'
        );
        if (ok) break;
        await sleep(200);
      }
      return { ok, text: String(ok) };
    }
  },
  {
    name: 'click node → float detail shows',
    run: async (ctx) => {
      // 模拟真实鼠标点击节点（非手动调 showDetail）：验证 点击→选中→浮动详情 全链路
      const chk = await ctx.exec(
        `(function () {
          var nodeEl = document.querySelector('jmnode[nodeid="tcp-handshake"]');
          if (!nodeEl) return 'no node el';
          nodeEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          var fd = document.querySelector('.float-detail');
          var visible = fd && fd.style.display !== 'none';
          var dc = document.querySelector('.float-detail .fd-detail-content');
          var text = dc ? dc.textContent.trim() : '';
          return 'visible=' + visible + ' len=' + text.length + ' hasHandshake=' + (text.indexOf('三次握手') >= 0);
        })()`
      );
      return { ok: /visible=true/.test(chk) && /hasHandshake=true/.test(chk), text: chk };
    }
  },
  {
    name: 'float detail sits below its node box (no flip, no clamp)',
    run: async (ctx) => {
      // 契约（positionFdBox · follow）：固定出现在「节点框的下面 +8px」；
      // 不上下翻转（否则节点上下移动时会上下区间跳）、也不夹进可见区。
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          app.positionFloatDetail();
          var fd = document.querySelector('.float-detail');
          var nodeEl = document.querySelector('jmnode[nodeid="tcp-handshake"]');
          if (!fd || fd.style.display === 'none' || !nodeEl) return 'missing';
          var fr = fd.getBoundingClientRect();
          var nr = nodeEl.getBoundingClientRect();
          var gap = Math.round(fr.top - nr.bottom);
          var cx = Math.round(fr.left + fr.width / 2);
          var ncx = Math.round(nr.left + nr.width / 2);
          return JSON.stringify({
            below: fr.top >= nr.bottom - 1, gap: gap,
            dxCenter: Math.abs(cx - ncx),
            fdTop: Math.round(fr.top), nodeBottom: Math.round(nr.bottom),
            ok: fr.top >= nr.bottom - 1 && gap >= 6 && gap <= 10 && Math.abs(cx - ncx) <= 2
          });
        })()`
      );
      let ok = false, detail = chk;
      try { ok = JSON.parse(chk).ok; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    name: 'wheel zoom at pointer',
    run: async (ctx) => {
      // 滚轮=缩放（非滚动）：派发 wheel 事件 → jsMind zoom_current 变化
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app.getState().jm;
          if (!jm) return 'no jm';
          var before = jm.view.zoom_current;
          var panel = document.querySelector('jmnodes').parentElement;
          var rect = panel.getBoundingClientRect();
          var e1 = new WheelEvent('wheel', { deltaY: -100, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true });
          panel.dispatchEvent(e1);
          var after = jm.view.zoom_current;
          // 还原
          var e2 = new WheelEvent('wheel', { deltaY: 100, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true });
          panel.dispatchEvent(e2);
          var restored = jm.view.zoom_current;
          return 'before=' + before + ' after=' + after + ' restored=' + restored;
        })()`
      );
      return { ok: /after=1\.1/.test(chk) && /restored=1/.test(chk), text: chk };
    }
  },
  {
    name: 'zoom range extended (0.15–4, beat old 2.1 cap)',
    run: async (ctx) => {
      // 配置生效 + 边界真实可达：缩小应低于旧下限 1 并受面板/最小限制卡住，
      // 放大应超过旧上限 2.1 直到新 max≈4；最后还原到 1
      const chk = await ctx.exec(
        `(function () {
          var jm = window.MMApp.getState().jm;
          if (!jm) return 'no jm';
          var z = jm.view.opts.zoom;
          var panel = document.querySelector('jmnodes').parentElement;
          var rect = panel.getBoundingClientRect();
          var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
          var fire = function (deltaY, n) {
            for (var i = 0; i < n; i++) {
              panel.dispatchEvent(new WheelEvent('wheel', { deltaY: deltaY, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
            }
          };
          fire(100, 60);
          var minReached = jm.view.zoom_current;
          fire(-100, 80);
          var maxReached = jm.view.zoom_current;
          fire(100, 30);
          var restored = jm.view.zoom_current;
          return JSON.stringify({ confMin: z.min, confMax: z.max, minReached: minReached, maxReached: maxReached, restored: restored });
        })()`
      );
      let ok = false, detail = chk;
      try {
        const o = JSON.parse(chk);
        ok = o.confMin === 0.15 && o.confMax === 4
          && o.minReached < 0.21
          && o.maxReached > 3.5
          && Math.abs(o.restored - 1) < 0.1;
      } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    name: 'zoom uses one transform only, never hidden scroll (no 显示不全)',
    run: async (ctx) => {
      // 直接回归用户报告：放大后内容被挪进"隐藏的滚动"里、又滚不回来 → 显示不全。
      // 新模型：缩放后 e_panel.scrollLeft/Top 恒为 0，缩放只体现在 canvas/jmnodes 的 transform 上。
      //   连线层为覆盖负坐标带逻辑原点平移（dataset.ox/oy），其 transform 比 jmnodes 多
      //   ox*s/oy*s —— 两者字符串不再相同，但几何上严格对齐（线不错位）；
      //   且被缩放的节点仍可通过「还原视图」找回（居中）。
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp; var jm = app.getState().jm;
          if (!jm) return { ok: false, text: 'no jm' };
          var panel = document.querySelector('jmnodes').parentElement;
          var canvasEl = panel.querySelector('canvas.jsmind');
          app.resetView();
          window.MM.setViewScale(3);                 // 真实用户路径（滚轮最终也走 zoomViewAt）
          app.positionFloatDetail();
          var sl = panel.scrollLeft, st = panel.scrollTop;
          var ps = app.getPanState();
          var nodesTf = document.querySelector('jmnodes').style.transform || '';
          var canvasTf = canvasEl.style.transform || '';
          var ox = Number(canvasEl.dataset.ox || 0), oy = Number(canvasEl.dataset.oy || 0);
          // 数值容差比较（zoomViewAt 浮点运算会产生 .4999… 与 .5 的格式差异，
          // 字符串逐字相等不合理；核心是 scale=3 且 canvas 比 jmnodes 多 ox*3/oy*3）。
          // 注意：本函数在 exec 的**模板字符串**内，正则反斜杠（\d \s \(）会被模板
          // 字符串转义吃掉而失效 —— 故用纯字符串解析，不写正则。
          function parseTf(tf) {
            var ti = tf.indexOf('translate('), si = tf.indexOf('scale(');
            if (ti < 0 || si < 0) return null;
            var tend = tf.indexOf(')', ti);
            var inner = tf.slice(ti + 10, tend);          // "-3110.5px, -4878.5px"
            var comma = inner.indexOf(',');
            var xs = inner.slice(0, comma).replace('px', '').trim();
            var ys = inner.slice(comma + 1).replace('px', '').trim();
            var send = tf.indexOf(')', si);
            var ss = tf.slice(si + 6, send).trim();
            return { x: Number(xs), y: Number(ys), s: Number(ss) };
          }
          var n = parseTf(nodesTf), c = parseTf(canvasTf);
          var T = 0.6;
          var nodesOk = !!n && Math.abs(n.s - 3) < 1e-6
            && Math.abs(n.x - ps.x) <= T && Math.abs(n.y - ps.y) <= T;
          var canvasOk = !!c && Math.abs(c.s - 3) < 1e-6
            && Math.abs(c.x - (ps.x + ox * 3)) <= T && Math.abs(c.y - (ps.y + oy * 3)) <= T;
          var alignOk = nodesOk && canvasOk;
          app.resetView();
          var rootEl = document.querySelector('jmnode[nodeid="root"]');
          var pr = panel.getBoundingClientRect();
          var r = rootEl.getBoundingClientRect();
          var centered = Math.abs((r.left + r.width / 2) - (pr.left + pr.width / 2)) <= 3
            && Math.abs((r.top + r.height / 2) - (pr.top + pr.height / 2)) <= 3;
          return { ok: sl === 0 && st === 0 && alignOk && centered,
            text: 'scroll=' + sl + ',' + st + ' alignOk=' + alignOk + ' centered=' + centered + ' ox=' + ox + ',oy=' + oy };
        })()`
      );
      return chk;
    }
  },
  {
    name: 'single live mindmap DOM tree (no duplicated jmnode)',
    run: async (ctx) => {
      // jsMind 不清理 container → 重复建图会在同一容器堆叠出多棵 DOM 树，出现重复 jmnode，
      // 于是 document.querySelector 可能命中旧树（详情框锚定/平移/滚动都会作用到错误元素）。
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app && app.getState ? app.getState().jm : null;
          if (!jm) return { ok: false, text: 'no jm' };
          var roots = document.querySelectorAll('jmnode[nodeid="root"]').length;
          var inners = document.querySelectorAll('#mindmap-container .jsmind-inner').length;
          var hosts = document.querySelectorAll('#jsmind_container').length;
          return { ok: roots === 1 && inners === 1 && hosts === 1,
            text: 'jmnode[root]=' + roots + ' jsmind-inner=' + inners + ' jsmind_container=' + hosts };
        })()`
      );
      return chk;
    }
  },
  {
    name: 'mindmap panel has no scrollbars (pan/zoom only)',
    run: async (ctx) => {
      // 需求：移除上下左右滚动条 —— 平移完全靠中键拖动、缩放靠滚轮
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app && app.getState ? app.getState().jm : null;
          if (!jm) return { ok: false, text: 'no jm' };
          var panel = document.querySelector('jmnodes').parentElement;
          var cs = getComputedStyle(panel);
          var sbW = panel.offsetWidth - panel.clientWidth;
          var sbH = panel.offsetHeight - panel.clientHeight;
          return { ok: cs.overflow === 'hidden' && sbW === 0 && sbH === 0,
            text: 'overflow=' + cs.overflow + ' scrollbarW=' + sbW + ' scrollbarH=' + sbH };
        })()`
      );
      return chk;
    }
  }
];

module.exports = assertions;
