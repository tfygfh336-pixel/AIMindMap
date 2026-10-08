/* ============================================================
 * scripts/smoke/08-audit-palette.js — 关系审计面板与命令面板
 * ------------------------------------------------------------
 * 覆盖 renderer/app-audit.js 与 renderer/app-palette.js 的**用户可见行为**：
 *   · 审计面板能打开、渲染出 CLI 给的两份清单、条目可点击、能一键补链接
 *   · 命令面板能打开、能搜到节点与命令、键盘可选、Enter 能定位节点
 * 这两项是「把 AI 已有的能力接到人手上」，因此断言必须走真实 IPC 与真实 DOM，
 * 不能只测函数存在（RULES R1：断言要来自实际执行）。
 *
 * 数据安全：断言只读真实项目，补链接那一项先用 export-json 的能力无法覆盖写操作，
 * 故补链接**只断言"按钮存在且携带正确的 from/to"**，不真的写盘 ——
 * 冒烟运行在项目副本上（07 域已验证），但避免在副本里留下无谓改动。
 * ============================================================ */
'use strict';

module.exports = [
  {
    name: '关系审计面板：打开后渲染出 orphans 与 mentions 两份清单',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           var st = app.getState();
           if (!st || !st.project) return { ok: false, text: 'no project loaded' };
           localStorage; // noop
           await app.openAudit();
           var p = document.getElementById('audit-panel');
           var visible = p && p.style.display !== 'none';
           var h3 = [].map.call(p.querySelectorAll('#audit-body h3'), function (x) { return x.textContent; });
           var body = p.querySelector('#audit-body').textContent || '';
           return {
             ok: visible && h3.length === 2 && /无引用但有内容/.test(h3[0]) && /正文提到却没建链接/.test(h3[1])
                 && body.indexOf('正在分析') < 0,
             text: 'visible=' + visible + ' h3=' + JSON.stringify(h3) + ' loading=' + (body.indexOf('正在分析') >= 0)
           };
         })()`
      );
      return r;
    }
  },
  {
    name: '关系审计面板：清单经真实 IPC 取得（与 CLI 结果一致，非渲染层自算）',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           var st = app.getState();
           var name = st.project.name;
           // 面板用的 IPC 结果 vs 直接调 CLI 的结果（主进程 runCli）
           var audit = await window.desktop.app.audit(name);
           if (!audit || !audit.orphans || !audit.mentions) return { ok: false, text: 'audit IPC 返回不完整' };
           var panelTxt = document.querySelector('#audit-panel #audit-body').textContent || '';
           // 面板里显示的孤立节点数应等于 IPC 报的 contentOrphans
           var shownCount = /无引用但有内容（(\\d+)）/.exec(document.querySelector('#audit-panel #audit-body').textContent);
           var n = shownCount ? Number(shownCount[1]) : -1;
           return {
             ok: Array.isArray(audit.orphans.items) && Array.isArray(audit.mentions.items)
                 && n === audit.orphans.contentOrphans,
             text: 'contentOrphans=' + audit.orphans.contentOrphans + ' 面板显示=' + n
                 + ' mentions=' + audit.mentions.mentions
           };
         })()`
      );
      return r;
    }
  },
  {
    name: '关系审计面板：mentions 条目带「补链接」按钮且携带正确的 from/to',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           var st = app.getState();
           var audit = await window.desktop.app.audit(st.project.name);
           var btns = document.querySelectorAll('#audit-panel .audit-link-btn');
           var m = (audit.mentions && audit.mentions.items) || [];
           if (!m.length) return { ok: btns.length === 0, text: '本项目无 mentions（0 条）→ 无按钮也正确' };
           var first = btns[0];
           if (!first) return { ok: false, text: '有 ' + m.length + ' 条 mentions 但没渲染出按钮' };
           var f = first.getAttribute('data-from'), t = first.getAttribute('data-to');
           var hit = m.some(function (x) { return x.from === f && x.to === t; });
           return { ok: btns.length === m.length && hit, text: '按钮=' + btns.length + ' 条=' + m.length + ' 首项 ' + f + '→' + t };
         })()`
      );
      return r;
    }
  },
  {
    name: '关系审计面板：点击孤立节点条目会定位并打开该节点详情',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           var li = document.querySelector('#audit-panel li[data-node]');
           if (!li) return { ok: true, text: '本项目无孤立节点条目（跳过）' };
           var id = li.getAttribute('data-node');
           li.click();
           await new Promise(function (res) { setTimeout(res, 120); });
           var st = app.getState();
           var sel = st.jm && st.jm.get_selected_node ? st.jm.get_selected_node() : null;
           var box = document.querySelector('.float-detail');
           return {
             ok: !!sel && sel.id === id && !!box && box.style.display !== 'none',
             text: '目标=' + id + ' 选中=' + (sel && sel.id) + ' 详情可见=' + (!!box && box.style.display !== 'none')
           };
         })()`
      );
      return r;
    }
  },
  {
    name: '关系审计面板：可关闭（关闭后不再遮挡界面）',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(function () {
           var app = window.MMApp;
           app.openAudit();
           var before = document.getElementById('audit-panel').style.display;
           document.getElementById('audit-close').click();
           var after = document.getElementById('audit-panel').style.display;
           return { ok: after === 'none', text: 'before=' + before + ' after=' + after };
         })()`
      );
      return r;
    }
  },
  {
    name: '命令面板：Ctrl+P 打开 ⇒ **只列命令**（用户 A 决定：节点不再混进来 ✓）',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
           // openPalette 是异步的（await IPC 拉取节点清单）：187 节点 comnet 固定 250ms
           // 不够 → 轮询等待 palette-item 渲染（≤3s）再断言，避免 flaky FAIL。
           var deadline = Date.now() + 3000;
           var items = [];
           while (Date.now() < deadline) {
             await new Promise(function (res) { setTimeout(res, 100); });
             items = document.querySelectorAll('#palette .palette-item');
             if (items.length > 0) break;
           }
           var p = document.getElementById('palette');
           var visible = p && p.style.display !== 'none';
           var hints = [].map.call(items, function (x) { return (x.querySelector('.palette-hint') || {}).textContent; });
           return {
             ok: visible && items.length > 0 && hints.indexOf('节点') < 0 && hints.indexOf('命令') >= 0,
             text: 'visible=' + visible + ' 项数=' + items.length + ' 含节点=' + (hints.indexOf('节点') >= 0) + ' 含命令=' + (hints.indexOf('命令') >= 0)
           };
         })()`
      );
      return r;
    }
  },
  {
    name: '命令面板：模糊搜索能过滤节点（输入「TCP」后结果均含该串）',
    run: async (ctx) => {
      // P3：面板只留命令 ⇒ 搜节点必须先切到节点模式 ✓
      await ctx.exec('window.MM.openPaletteNodes && window.MM.openPaletteNodes(); 1');
      const r = await ctx.exec(
        `(async function () {
           var inp = document.getElementById('palette-input');
           inp.value = 'TCP';
           inp.dispatchEvent(new Event('input'));
           await new Promise(function (res) { setTimeout(res, 250); });
           var items = document.querySelectorAll('#palette .palette-item');
           var labels = [].map.call(items, function (x) { return x.querySelector('.palette-label').textContent; });
           var allMatch = labels.length > 0 && labels.every(function (l) { return /tcp/i.test(l); });
           return { ok: allMatch, text: '结果=' + labels.length + ' 首项=' + JSON.stringify(labels.slice(0, 3)) };
         })()`
      );
      return r;
    }
  },
  {
    name: '命令面板：Enter 定位到选中节点并打开其详情，Esc 关闭',
    run: async (ctx) => {
      // P3：面板只留命令 ⇒ 搜节点必须先切到节点模式 ✓
      await ctx.exec('window.MM.openPaletteNodes && window.MM.openPaletteNodes(); 1');
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           var inp = document.getElementById('palette-input');
           inp.value = 'TCP';
           inp.dispatchEvent(new Event('input'));
           await new Promise(function (res) { setTimeout(res, 250); });
           var first = document.querySelector('#palette .palette-item');
           if (!first) return { ok: false, text: '无结果' };
           var label = first.querySelector('.palette-label').textContent;
           inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
           await new Promise(function (res) { setTimeout(res, 200); });
           var st = app.getState();
           var sel = st.jm && st.jm.get_selected_node ? st.jm.get_selected_node() : null;
           var closed = document.getElementById('palette').style.display === 'none';
           return {
             ok: !!sel && sel.topic === label && closed,
             text: '目标=' + label + ' 选中=' + (sel && sel.topic) + ' 已关闭=' + closed
           };
         })()`
      );
      return r;
    }
  },
  {
    name: '命令面板：命令项可执行（选中「关系审计」后审计面板被打开）',
    run: async (ctx) => {
      // 第一版用「展开全部是否让可见节点变多」来验证，结果永远相等 —— 因为 jsMind
      // 折叠时节点仍留在 DOM 里（靠样式隐藏），数 jmnode 数量测不出折叠。
      // 改用**不依赖 jsMind 内部实现**的可观测副作用：命令执行后 DOM 出现面板。
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           app.closeAudit();
           document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
           // 轮询直到过滤生效：openPalette 异步渲染 + input 过滤是 timer，全链 verify
           // （CLI 集成后紧接冒烟）负载高时固定 250ms 等待不够（实测首项停在空查询的
           // 「展开全部」），改为每 150ms 重输一次并检查首项，最长 ~4.5s（同本条断言
           // 上方 Ctrl+P 那条的轮询先例）。
           var first = null, hint = null, label = null;
           for (var t = 0; t < 30; t++) {
             await new Promise(function (res) { setTimeout(res, 150); });
             var i2 = document.getElementById('palette-input');
             if (!i2) continue;
             i2.value = '关系审计';
             i2.dispatchEvent(new Event('input'));
             first = document.querySelector('#palette .palette-item');
             if (!first) continue;
             label = first.querySelector('.palette-label');
             if (label && label.textContent.indexOf('关系审计') >= 0) break;
           }
           hint = first && first.querySelector('.palette-hint');
           if (!first || !label || label.textContent.indexOf('关系审计') < 0) {
             return { ok: false, text: '搜不到「关系审计」命令项' };
           }
           first.click();
           await new Promise(function (res) { setTimeout(res, 500); });
           var p = document.getElementById('audit-panel');
           return {
             ok: !!p && p.style.display !== 'none'
                 && (label.textContent || '').indexOf('关系审计') >= 0
                 && (hint.textContent || '') === '命令',
             text: '首项=' + JSON.stringify(label.textContent) + ' 类型=' + (hint && hint.textContent)
                 + ' 审计面板可见=' + (!!p && p.style.display !== 'none')
           };
         })()`
      );
      return r;
    }
  },
  {
    name: '命令面板：空查询时**只列命令**（节点不混入；命令必须在截断前可见 ✓）',
    run: async (ctx) => {
      // 回归断言（P3 后仍有效）：空查询下**命令必须都看得见** —— 旧实现里 131 个节点占满前 50 名，
      // 命令被 slice 全部截掉 —— 打开面板一个命令都看不到。
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           app.closeAudit();
           app.closePalette();
           await app.openPalette();
           await new Promise(function (res) { setTimeout(res, 300); });
           var items = document.querySelectorAll('#palette .palette-item');
           var kinds = [].map.call(items, function (x) {
             return (x.querySelector('.palette-hint') || {}).textContent;
           });
           var nMention = items.length;
           var firstKind = kinds[0];
           app.closePalette();
           return {
             ok: nMention > 0 && kinds.indexOf('命令') >= 0 && kinds.indexOf('节点') < 0 && firstKind === '命令',
             text: '项数=' + nMention + ' 命令数=' + kinds.filter(function (k) { return k === '命令'; }).length
                 + ' 节点数=' + kinds.filter(function (k) { return k === '节点'; }).length + ' 首项类型=' + firstKind
           };
         })()`
      );
      return r;
    }
  },
  {
    // 这一条锁住一个**曾经的真实数据丢失路径**：补链接原先用 openProject() 重载项目，
    // 而本工程的编辑只存在内存里（要用户点保存才落盘），于是"补链接"会静默丢弃
    // 用户未保存的编辑、并清空撤销栈。现改为就地补链，此处断言该性质不被改回。
    name: '关系审计：补链接不丢未保存的内存编辑、不重置撤销栈（就地补链）',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           var st = app.getState();
           var jm = st.jm;
           var audit = await window.desktop.app.audit(st.project.name);
           var m = (audit.mentions && audit.mentions.items) || [];
           if (!m.length) return { ok: true, text: '本项目无 mentions 可补（跳过真实写入）' };
           // 造一个"未保存的内存编辑"：加节点只进内存与撤销栈，不落盘
           var tmpId = 'audit-probe-tmp';
           jm.add_node('root', tmpId, '未保存探针', { detail: '' });
           var existedBefore = !!jm.get_node(tmpId);
           var pair = m[0];
           await app.addLinkFromAudit(pair.from, pair.to);
           var keptEdit = !!jm.get_node(tmpId);          // 未保存编辑未被丢弃
           var keptHistory = st.history.canUndo();       // 撤销栈未被重置
           var fn = jm.get_node(pair.from);
           var linkedInMem = !!(fn && fn.data && (fn.data.links || []).some(function (l) {
             return l && l.id === pair.to;
           }));
           jm.remove_node(tmpId);                        // 清理探针（仅内存）
           return {
             ok: existedBefore && keptEdit && keptHistory && linkedInMem,
             text: '未保存编辑保留=' + keptEdit + ' 撤销栈保留=' + keptHistory
                 + ' 内存已补链=' + linkedInMem + ' 对=' + pair.from + '→' + pair.to
           };
         })()`
      );
      return r;
    }
  },
  {
    // 锁住一个**真实的数据安全缺陷**：`runCli()` 调起的 CLI 是**另一个进程**，
    // 它自己算 `projects/` 路径。若宿主不把沙箱目录传给它，CLI 会写**真实项目** ——
    // 冒烟里任何经 CLI 的写操作（如上面的"补链接"）都会污染用户数据。
    // 本断言做端到端证明：补链接后从**沙箱副本**重新读回，链接必须在那里。
    // 若 CLI 仍写真实目录，则渲染层读的是沙箱、CLI 写的是真实 → 读不到 → 失败。
    name: '冒烟沙箱：经 CLI 的写操作也落在副本上（CLI 子进程遵守沙箱目录）',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           var st = app.getState();
           var name = st.project.name;
           var file = st.project.file;
           // 前置：本项目确实在冒烟副本里（07 域已断言过，这里再确认一次以自洽）
           var inSandbox = /ai-mind-map-smoke-/.test(file || '');
           var audit = await window.desktop.app.audit(name);
           var m = (audit.mentions && audit.mentions.items) || [];
           if (!m.length) return { ok: inSandbox, text: '无 mentions 可补；沙箱=' + inSandbox };
           var pair = m[0];
           await app.addLinkFromAudit(pair.from, pair.to);
           // 从磁盘（沙箱副本）重新读回，确认 CLI 的写入落在这里
           var reread = await window.desktop.project.read(name);
           function find(node, id) {
             if (!node) return null;
             if (node.id === id) return node;
             var kids = node.children || [];
             for (var i = 0; i < kids.length; i++) { var r = find(kids[i], id); if (r) return r; }
             return null;
           }
           var from = find(reread.data.data, pair.from);
           var hit = !!(from && (from.links || []).some(function (l) {
             return l && l.id === pair.to;
           }));
           return {
             ok: inSandbox && hit,
             text: '沙箱=' + inSandbox + ' CLI 写入落在副本=' + hit
                 + ' 对=' + pair.from + '→' + pair.to + ' 文件=' + file
           };
         })()`
      );
      return r;
    }
  }
];
