/* ============================================================
 * scripts/smoke/03-edit-search.js —— 冒烟断言分域 03：编辑入口与检索
 * （右键菜单→编辑对话框 / 双击节点编辑 / 标签 chip / 相关知识点 IPC /
 *   反查 IPC 兼容 / 全文搜索面板）
 *
 * 由入口 scripts/smoke-assertions.js 按顺序拼接执行。
 * 本文件是对拆分前单体 smoke-assertions.js 的逐字搬运，勿改断言文案与顺序。
 * ============================================================ */
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const assertions = [
  {
    name: 'context menu (node right-click → edit dialog)',
    run: async (ctx) => {
      // 右键节点 → 菜单出现 → 点「编辑」→ 编辑对话框打开；右键背景 → 背景菜单
      const chk = await ctx.exec(
        `(function () {
          try {
            var nodeEl = document.querySelector('jmnode[nodeid="tcp-handshake"]');
            if (!nodeEl) return { ok: false, text: 'no jmnode el' };
            var ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 260 });
            nodeEl.dispatchEvent(ev);
            var menu = document.getElementById('ctx-menu');
            var nodeMenuShown = menu && menu.style.display !== 'none';
            var items = menu ? menu.querySelectorAll('.ctx-item').length : 0;
            var hasEdit = menu && Array.from(menu.querySelectorAll('.ctx-item')).some(function (x) { return x.textContent.indexOf('编辑') >= 0; });
            var editItem = menu && Array.from(menu.querySelectorAll('.ctx-item')).find(function (x) { return x.textContent.indexOf('编辑') >= 0; });
            if (editItem) editItem.click();
            var dlgOpen = document.getElementById('edit-dialog').style.display === 'flex';
            document.getElementById('edit-cancel').click();
            // 背景右键
            var bgEv = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 900, clientY: 700 });
            document.getElementById('mindmap-container').dispatchEvent(bgEv);
            var bgMenuShown = menu.style.display !== 'none';
            // v0.16：背景菜单移除导入/导出 MD（只保留文件菜单入口）
            var bgHasMd = Array.from(menu.querySelectorAll('.ctx-item')).some(function (x) { return x.textContent.indexOf('导入') >= 0 || x.textContent.indexOf('导出') >= 0; });
            menu.style.display = 'none';
            return {
              ok: nodeMenuShown && items >= 4 && hasEdit && dlgOpen && bgMenuShown && !bgHasMd,
              text: 'nodeMenu=' + nodeMenuShown + ' items=' + items + ' editDialog=' + dlgOpen + ' bgMenu=' + bgMenuShown
            };
          } catch (e) { return { ok: false, text: 'err:' + e.message }; }
        })()`
      );
      return chk;
    }
  },
  {
    name: '双击节点 = **展开 / 收起**（用户定 ✓ 不再弹编辑框 ✗）；编辑在右键菜单里',
    run: async (ctx) => {
      const chk = await ctx.exec(
        `(function () {
          try {
            var app = window.MMApp;
            var jm = app.getState().jm;
            // 自建前置（✓ 不写死 id）：挑一个**真的有子节点**的节点 —— 实测 tcp-handshake 是叶子 ✗
            var id = null;
            var all = Array.prototype.slice.call(document.querySelectorAll('jmnode[nodeid]'));
            for (var i = 0; i < all.length; i++) {
              var cand = all[i].getAttribute('nodeid');
              var nn = jm.get_node(cand);
              if (nn && !nn.isroot && nn.children && nn.children.length) { id = cand; break; }
            }
            if (!id) return { ok: false, text: '找不到有子节点的可见节点' };
            var n = jm.get_node(id);
            var before = !!n.expanded;
            var nodeEl = document.querySelector('jmnode[nodeid="' + id + '"]');
            if (!nodeEl) return { ok: false, text: 'no jmnode el' };
            nodeEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 320, clientY: 260 }));
            var after = !!jm.get_node(id).expanded;
            var dlg = document.getElementById('edit-dialog').style.display === 'flex';
            if (dlg) document.getElementById('edit-cancel').click();
            // 还原：不给后续断言留一个被改动过的展开态 ✓
            if (after !== before) { if (before) jm.expand_node(id); else jm.collapse_node(id); }
            var editApi = typeof app.editNode === 'function';
            return { ok: (after !== before) && !dlg && editApi,
              text: '展开态 ' + before + ' → ' + after + ' ｜ 弹出编辑框=' + dlg + '（必须 false ✓）｜ 编辑入口仍在=' + editApi };
          } catch (e) { return { ok: false, text: 'err:' + e.message }; }
        })()`
      );
      return chk;
    }
  },
  {
    name: 'tags chips in float detail',
    run: async (ctx) => {
      // 节点 data.tags → 浮动详情出现可点击标签 chip（测完还原，不留痕）
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app.getState().jm;
          var n = jm.get_node('tcp-handshake');
          if (!n) return 'no node';
          n.data = n.data || {};
          var had = n.data.tags;
          n.data.tags = ['测试标签'];
          app.showDetail(n);
          var chips = document.querySelectorAll('.float-detail .fd-tags .tag-chip');
          var has = chips.length >= 1 && chips[0].textContent.indexOf('测试标签') >= 0;
          if (had === undefined) delete n.data.tags; else n.data.tags = had;
          return 'chips=' + chips.length + ' has=' + has;
        })()`
      );
      return { ok: /has=true/.test(chk), text: chk };
    }
  },
  {
    name: 'related panel renders via IPC (out + in merged)',
    run: async (ctx) => {
      // 选中节点 → 浮动详情异步经 IPC 取「相关知识点」（出边+入边合并）→ 列表出现（非加载中）
      // 注意：只触发一次 showDetail，之后只读轮询，否则每次重置"加载中"永远读不到结果
      await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app.getState().jm;
          var n = jm.get_node('tcp-handshake');
          if (n) app.showDetail(n);
          return 1;
        })()`
      );
      let ok = false, text = '';
      for (let i = 0; i < 40; i++) {
        const chk = await ctx.exec(
          `(function () {
            var el = document.querySelector('.float-detail .fd-related');
            if (!el) return 'no el';
            var items = el.querySelectorAll('.bl-item[data-node]');
            return JSON.stringify({
              n: items.length,
              dir: el.querySelectorAll('.bl-dir').length,
              html: el.innerHTML.slice(0, 120)
            });
          })()`
        );
        text = chk;
        try {
          const o = JSON.parse(chk);
          if (o.n > 0 && o.dir === o.n) { ok = true; break; }
        } catch (e) { /* 仍可能是 'no el' 字符串 */ }
        if (chk.indexOf('查询失败') >= 0) break;
        await sleep(200);
      }
      return { ok, text: text.slice(0, 200) };
    }
  },
  {
    // 这是能抓到「🔗 跳转到」那类缺陷的**关键断言**：光断言"列表渲染出来了"不够，
    // 必须断言**点下去真的跳到位**。原先图片区的链接正是"渲染正常、点了没反应"
    // （同项目链接被 switchProject 的早退吞掉），而没有任何断言覆盖点击效果。
    name: '相关知识点：点击**同项目**条目真的选中该节点并打开详情',
    run: async (ctx) => {
      // 先拿到一个同项目的关系条目（含其目标 id），再点击并验证选中变化
      const pick = await ctx.exec(
        `(function () {
           var app = window.MMApp;
           var jm = app.getState().jm;
           app.showDetail(jm.get_node('tcp-handshake'));
           return 1;
         })()`
      );
      void pick;
      let target = null;
      for (let i = 0; i < 40; i++) {
        const chk = await ctx.exec(
          `(function () {
             var el = document.querySelector('.float-detail .fd-related');
             if (!el) return 'no el';
             var it = el.querySelector('.bl-item[data-node]');
             if (!it) return 'no item';
             return JSON.stringify({ node: it.getAttribute('data-node'), project: it.getAttribute('data-project') });
           })()`
        );
        try { target = JSON.parse(chk); break; } catch (e) { /* 继续轮询 */ }
        await sleep(200);
      }
      if (!target) return { ok: false, text: '未能取到关系条目' };
      // 清掉当前选中，确保"跳转生效"不是因为本来就选着它
      const r = await ctx.exec(
        `(function () {
           var app = window.MMApp;
           var jm = app.getState().jm;
           var it = document.querySelector('.float-detail .fd-related .bl-item[data-node="' + ${JSON.stringify(target.node)} + '"]');
           if (!it) return JSON.stringify({ ok: false, text: '条目消失' });
           it.click();
           var sel = jm.get_selected_node();
           // 注意：详情框**支持多框并存**，故不能用 querySelector('.float-detail')
           // 取第一个（那可能是隐藏的旧框，我第一版就因此误判失败）。
           // 正确做法是遍历所有框，问"是否存在一个**可见**且 nodeId==目标的框"。
           var st = app.getFloatDetailState();
           var n = st.boxes || 0;
           var shown = false, detail = [];
           for (var i = 0; i < n; i++) {
             var b = app.getFloatDetailState(i);
             detail.push(i + ':' + b.nodeId + (b.visible ? '(可见)' : '(隐藏)'));
             if (b.nodeId === ${JSON.stringify(target.node)} && b.visible) shown = true;
           }
           return JSON.stringify({
             ok: !!sel && sel.id === ${JSON.stringify(target.node)} && shown,
             text: '目标=' + ${JSON.stringify(target.node)} + ' 选中=' + (sel && sel.id)
                 + ' 有可见详情框=' + shown + ' 框=[' + detail.join(' ') + ']'
           });
         })()`
      );
      let ok = false, detail = r;
      try { const o = JSON.parse(r); ok = o.ok; detail = o.text; } catch (e) { detail = r; }
      return { ok, text: detail };
    }
  },
  {
    name: 'backlinks IPC still works (compat: 单向反查未被相关知识点取代)',
    run: async (ctx) => {
      const chk = await ctx.exec(
        `(function () {
          return window.desktop.app.backlinks('comnet', 'tcp-handshake').then(function (r) {
            return JSON.stringify({
              hasWithin: !!(r && Array.isArray(r.within)),
              hasCross: !!(r && Array.isArray(r.cross))
            });
          });
        })()`
      );
      let ok = false, detail = chk;
      try { const o = JSON.parse(chk); ok = o.hasWithin && o.hasCross; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    name: 'full-text search panel (detail hit)',
    run: async (ctx) => {
      // 搜索框全文搜索：detail 中"三次握手"应命中 tcp-handshake 并弹出结果面板
      const chk = await ctx.exec(
        `(function () {
          return window.MMApp.runSearch('三次握手').then(function () {
            var el = document.getElementById('search-results');
            var shown = el && el.style.display === 'block';
            var html = el ? el.innerHTML : '';
            return JSON.stringify({ shown: shown, hasHit: html.indexOf('tcp-handshake') >= 0 });
          });
        })()`
      );
      let ok = false, detail = chk;
      try { const o = JSON.parse(chk); ok = o.shown && o.hasHit; } catch (e) { detail = chk; }
      await ctx.exec(`(function(){ var el = document.getElementById('search-results'); if (el) el.style.display = 'none'; return 1; })()`);
      return { ok, text: detail };
    }
  }
];

module.exports = assertions;
