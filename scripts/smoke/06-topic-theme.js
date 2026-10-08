/* ============================================================
 * scripts/smoke/06-topic-theme.js —— 冒烟断言分域 06：顶层主题、主题模式与窗口尺寸
 * （addTopic 新增顶层主题 / 主题模式容器根隐藏 / 大锁冻结尺寸与位置 / 8 个缩放手柄 /
 *   主题布局 meta.layout 左右分侧）
 *
 * 由入口 scripts/smoke-assertions.js 按顺序拼接执行。
 * 本文件是对拆分前单体 smoke-assertions.js 的逐字搬运，勿改断言文案与顺序。
 * ============================================================ */
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const assertions = [
  {
    name: 'addTopic 凭空新增顶层主题（挂到根下，可多主题并存）',
    run: async (ctx) => {
      // 需求：一个笔记项目里放多个不同方面的笔记
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app && app.getState ? app.getState().jm : null;
          if (!jm) return { ok: false, text: 'no jm' };
          var root = jm.get_node('root');
          var before = (root.children || []).length;
          var topics = ['__probe_topic_1', '__probe_topic_2'];
          topics.forEach(function (t) {
            var id = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            jm.add_node('root', id, t, { detail: '' });
          });
          var after = (root.children || []).length;
          var found = topics.every(function (t) {
            return (jm.get_node('root').children || []).some(function (c) { return c.topic === t; });
          });
          // 清理：移除刚加的两个顶层主题
          (jm.get_node('root').children || []).slice().forEach(function (c) {
            if (topics.indexOf(c.topic) >= 0) jm.remove_node(c.id);
          });
          var cleaned = (jm.get_node('root').children || []).length;
          return { ok: after === before + 2 && found && cleaned === before
              && typeof app.addTopic === 'function' && typeof app.resetView === 'function',
            text: 'rootKids ' + before + ' -> ' + after + ' -> ' + cleaned + ' found=' + found
              + ' api=' + (typeof app.addTopic) + '/' + (typeof app.resetView) };
        })()`
      );
      return chk;
    }
  },
  {
    name: '主题模式：容器根隐藏 + 其连线被跳过 + 标题转角标',
    run: async (ctx) => {
      // 需求：顶层主题要"独立"，不被中心节点连线牵着
      const chk = await ctx.exec(
        `(function () {
          try {
          var app = window.MMApp;
          var st = app.getState();
          if (!st.jm) return { ok: false, text: 'no jm' };
          var wasThemed = app.isThemeMode();
          var topic = (st.jm.get_node('root') || {}).topic;
          app.setRootMode('themes');
          var jm2 = app.getState().jm;
          var rootEl = document.querySelector('#jsmind_container jmnode[nodeid="root"]');
          var hidden = !!(rootEl && rootEl.classList.contains('mm-container-root'));
          var vis = rootEl ? getComputedStyle(rootEl).visibility : '?';
          var label = document.getElementById('mm-root-label');
          var labelText = label ? label.textContent : null;
          var kids = ((jm2.get_node('root') || {}).children || []).length;
          var skippedThemes = window.__mmSkippedLines || 0;
          app.setRootMode('tree'); // 切回单中心
          var skippedTree = window.__mmSkippedLines || 0;
          var back = document.querySelector('#jsmind_container jmnode[nodeid="root"]');
          var restored = !back || !back.classList.contains('mm-container-root');
          if (wasThemed) app.setRootMode('themes'); // 复原
          return {
            ok: hidden && vis === 'hidden' && labelText === topic
              && skippedThemes === kids && skippedTree === 0 && kids > 0 && restored,
            text: 'hidden=' + hidden + ' visibility=' + vis + ' label=' + labelText
              + ' rootKids=' + kids + ' skippedThemes=' + skippedThemes
              + ' skippedTree=' + skippedTree + ' restored=' + restored
          };
          } catch (err) { return { ok: false, text: 'THREW: ' + (err && err.message) + ' @ ' + (err && err.stack) }; }
        })()`
      );
      return chk;
    }
  },
  {
    name: '大锁 (screen lock) freezes size and position across zoom change',
    run: async (ctx) => {
      // 需求：大锁之后，位置和大小都不应再变化 —— 相对屏幕静止
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
              box.querySelector('.fd-lock-screen').click();
              var st0 = app.getFloatDetailState();
              var w0 = box.getBoundingClientRect().width;
              window.MM.setViewScale(1.5);
              app.positionFloatDetail();
              setTimeout(function () {
                var st1 = app.getFloatDetailState();
                var w1 = box.getBoundingClientRect().width;
                window.MM.setViewScale(1);
                app.positionFloatDetail();
                res(JSON.stringify({
                  lock: st0.lock, left: st0.left + '->' + st1.left, top: st0.top + '->' + st1.top,
                  width: Math.round(w0) + '->' + Math.round(w1),
                  ok: st0.lock === 'screen' && st1.left === st0.left && st1.top === st0.top
                    && Math.abs(w1 - w0) <= 1
                }));
              }, 250);
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
    name: 'resize handles: 8 handles present; SE drag grows the box',
    run: async (ctx) => {
      // 需求：像普通 Windows 窗口一样在四边/四角拖动改大小
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp; var jm = app.getState().jm;
          if (!jm) return Promise.resolve(JSON.stringify({ ok: false, reason: 'no jm' }));
          app.closeAllFloatDetail();
          window.MM.setViewScale(1);
          app.showDetail(jm.get_node('tcp-handshake'));
          return new Promise(function (res) {
            setTimeout(function () {
              var fd = document.querySelector('.float-detail');
              var n = fd.querySelectorAll('.fd-rs').length;
              fd.style.maxWidth = 'none'; fd.style.maxHeight = 'none';
              fd.style.width = '300px'; fd.style.height = '200px';
              var w0 = fd.offsetWidth, h0 = fd.offsetHeight;
              var se = fd.querySelector('.fd-rs-se');
              se.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 500, clientY: 500 }));
              document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 560, clientY: 545 }));
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
              var w1 = fd.offsetWidth, h1 = fd.offsetHeight;
              res(JSON.stringify({
                handles: n, size: w0 + 'x' + h0 + ' -> ' + w1 + 'x' + h1,
                dw: w1 - w0, dh: h1 - h0,
                ok: n === 8 && (w1 - w0) === 60 && (h1 - h0) === 45
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
    name: 'theme-layout: meta.layout 驱动顶层主题左右分侧（direction 生效）',
    run: async (ctx) => {
      // CLI 造数据（冒烟运行在临时副本，不碰真实项目）；再打开验证渲染链路：
      // meta.layout.left 的主题 direction=-1（左侧），未列出的默认右侧（direction=1）。
      // 取证探针（测试侧 ✓ 不改产品代码）：记录这段窗口里每一次 renderMind 的[项目名 | meta.layout]
      await ctx.exec(`(function () {
        if (window.__mmRenderProbe) { window.__mmRenderProbe = []; return 1; }
        var orig = window.MM.renderMind;
        window.__mmRenderProbe = [];
        window.MM.renderMind = function (data) {
          try {
            var st = window.MMApp.getState();
            window.__mmRenderProbe.push(((st.project && st.project.name) || '?') + '|'
              + JSON.stringify(((data || {}).meta || {}).layout || null));
          } catch (e) { /* 探针自身绝不许影响被测行为 */ }
          return orig.apply(this, arguments);
        };
        return 1;
      })()`);
      const init = await ctx.runCli(['init', 'layout-probe', '--title', '布局探针']);
      if (!/已创建/.test(init)) return { ok: false, text: 'init failed: ' + init };
      const a1 = await ctx.runCli(['add-root', 'layout-probe', '--topic', '左主题', '--id', 'l1']);
      if (!/已添加顶层主题/.test(a1)) return { ok: false, text: 'add-root l1 failed: ' + a1 };
      const a2 = await ctx.runCli(['add-root', 'layout-probe', '--topic', '右主题', '--id', 'r1']);
      if (!/已添加顶层主题/.test(a2)) return { ok: false, text: 'add-root r1 failed: ' + a2 };
      const tl = await ctx.runCli(['theme-layout', 'layout-probe', '--left', 'l1']);
      if (!/已设置主题布局/.test(tl)) return { ok: false, text: 'theme-layout failed: ' + tl };
      // 前置加固（断言自建前置 ✓）：ready 只证明「项目名对了」，**不证明树真的换了** ——
      // 全量跑实测出现过 project.name=layout-probe 而内存树/metaLayout 仍是 comnet 的 ✗
      //（真因是产品侧「迟到的异步读盘重建」，已在 app-actions.js 加世代核对修掉；这里再加一道
      // 自证：最多 3 次「打开 → 等到真能取到 l1/r1」，仍不行才判红并带现场 ✓）
      let ready = false;
      for (let attempt = 0; attempt < 3 && !ready; attempt++) {
        await ctx.exec('window.MMApp.openProject("layout-probe")');
        for (let i = 0; i < 12; i++) {   // 每次最多等 ~2.4s
          ready = await ctx.exec(
            '(function () { var st = window.MMApp.getState(); return !!(st.project && st.project.name === "layout-probe"'
            + ' && st.jm && st.jm.get_node && st.jm.get_node("l1") && st.jm.get_node("r1")); })()'
          );
          if (ready) break;
          await sleep(200);
        }
      }
      if (!ready) {
        const d0 = await ctx.exec('JSON.stringify({ name: (window.MMApp.getState().project || {}).name, meta: window.MMApp.getState().metaLayout || null })');
        return { ok: false, text: 'project/tree not ready（3 次重开都没取到 l1/r1）｜' + d0 };
      }
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app && app.getState ? app.getState().jm : null;
          if (!jm) return 'no jm';
          var l = jm.get_node('l1'), r = jm.get_node('r1');
          var metaLayout = app.getState().metaLayout;
          return JSON.stringify({
            lDir: l ? l.direction : null, rDir: r ? r.direction : null,
            metaLayout: metaLayout ? JSON.stringify(metaLayout) : null,
            ok: l && r && l.direction === -1 && r.direction === 1
              && metaLayout && metaLayout.left && metaLayout.left.indexOf('l1') === 0
          });
        })()`
      );
      // 现场数据（失败信息必须自带 ✓）：应用内存实况 + 磁盘上那份 layout-probe 的实况
      const diag = await ctx.exec(`(async function () {
        var out = {};
        try {
          var st = window.MMApp.getState();
          out.name = (st.project && st.project.name) || null;
          out.file = (st.project && st.project.file) || null;
          out.ml = st.metaLayout ? JSON.stringify(st.metaLayout) : null;
          out.assoc = (st.assoc || []).length;
          out.renderLog = window.__mmRenderProbe || null;
          var jm = st.jm;
          out.l1 = !!(jm && jm.get_node && jm.get_node('l1'));
          out.r1 = !!(jm && jm.get_node && jm.get_node('r1'));
          out.rootOk = !!(jm && jm.get_root && jm.get_root());
          var n = 0;
          if (jm && jm.mind && jm.mind.root) { (function w(x) { n++; (x.children || []).forEach(w); })(jm.mind.root); }
          out.nodes = n;
        } catch (e) { out.stateErr = String((e && e.message) || e); }
        try {
          var r = await window.desktop.project.read('layout-probe');
          out.diskFile = r.file;
          out.diskMl = JSON.stringify(((r.data || {}).meta || {}).layout || null);
          out.diskKids = (((r.data || {}).data || {}).children || []).map(function (c) { return c.id; });
        } catch (e2) { out.diskErr = String((e2 && e2.message) || e2); }
        return JSON.stringify(out);
      })()`);
      // 复原项目上下文：后续 07–10 分域全部以 comnet 为基准项目（含 tcp-handshake）。
      // 教训：本断言此前 openProject('layout-probe') 后未切回，导致 07 undo/redo /
      // attachment 与 09 保存断言在只有两个主题的 layout-probe 上运行而连锁失败。
      await ctx.exec('window.MMApp.openProject("comnet")');
      let back = false;
      for (let i = 0; i < 40; i++) {
        back = await ctx.exec(
          'window.__mindReady === true && window.MMApp.getState().project && window.MMApp.getState().project.name === "comnet"'
        );
        if (back) break;
        await sleep(200);
      }
      return { ok: /"ok":true/.test(chk) && back, text: chk + ' ｜ 现场=' + diag + ' ｜ 切回comnet=' + back };
    }
  }
];

module.exports = assertions;
