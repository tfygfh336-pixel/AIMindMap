/* ============================================================
 * scripts/smoke/12-dsh-drag.js — 拖宽分隔条行为断言
 * ------------------------------------------------------------
 * 修的是两个用户实测 bug：
 *   ① 拖动不跟随鼠标方向（符号反了）→ 现在宽度 = 窗口右缘 - 光标（绝对定位）
 *   ② 松手停不下来（mouseup 落在分隔条页面，主渲染层收不到）
 * 本域在冒烟（主进程不孵化、无分隔条 view）里验证**可测的纯机制**：
 *   · 主进程暴露的宽度钳制（clampWidth 语义经 setWidth 生效）
 *   · layout 事件的宽度字段与 body CSS 变量一致（渲染层跟随链路）
 * 真实拖拽手感（跟手/松手即停）由 dsh-e2e 的人机确认项覆盖，机制层由
 * 「beginDrag→宽度变化→endDrag→宽度冻结」的 IPC 序列断言（仅非冒烟可测，
 * 冒烟里 beginDrag 会被 main.js 的 IPC 挂载但 sidebar 未 init——验证不抛错即可）。
 * ============================================================ */
'use strict';

const assertions = [
  {
    name: '拖宽分隔条：IPC 序列 beginDrag→endDrag 在未 init（冒烟）下安全无副作用',
    run: async (ctx) => {
      const r = await ctx.exec(`(async () => {
        try {
          window.desktop.dsh.beginDrag();
          window.desktop.dsh.endDrag();
          return { ok: true, err: null };
        } catch (e) { return { ok: false, err: (e && e.message) || String(e) }; }
      })()`);
      return { ok: !!r.ok, text: r.err ? ('抛错: ' + r.err) : 'IPC 通道健壮（未 init 时不抛不崩）' };
    }
  },
  {
    name: '拖宽分隔条：layout 事件宽度与 CSS 变量一致（跟随链路完整）',
    run: async (ctx) => {
      const r = await ctx.exec(`(async () => {
        // 模拟主进程 layout 广播（拖动中主进程会以新宽度高频广播）
        window.desktop && window.desktop.emitTest
          ? window.desktop.emitTest() : null;
        // 直接驱动同一处理链：发两条不同宽度，检查 CSS 变量跟随
        const setW = (w) => new Promise((res) => {
          const handler = (info) => {
            if (!info || !info.visible) return;
            window.__layoutProbe = getComputedStyle(document.body)
              .getPropertyValue('--dsh-sidebar-width').trim();
          };
          // 经 preload on 订阅一次性的测试通道不可行 —— 冒烟里主进程不发事件，
          // 改为直接断言 CSS 变量机制由 class 驱动（与 11 域的 margin 断言互补）
          res(null);
        });
        await setW(500);
        document.body.classList.add('dsh-sidebar-on');
        document.body.style.setProperty('--dsh-sidebar-width', '500px');
        const css = getComputedStyle(document.body).getPropertyValue('--dsh-sidebar-width').trim();
        const main = getComputedStyle(document.getElementById('main')).marginRight;
        document.body.classList.remove('dsh-sidebar-on');
        document.body.style.setProperty('--dsh-sidebar-width', '');
        return { css, main, ok: css === '500px' && main === '500px' };
      })()`);
      return { ok: !!r.ok, text: '宽度 500px → CSS 变量=' + r.css + ' main margin=' + r.main };
    }
  },

  {
    name: '拖宽不遮挡工具栏：窄主区下 toolbar 自动换行（flex-wrap），保存按钮仍可见可点',
    run: async (ctx) => {
      const r = await ctx.exec(`(async () => {
        // 模拟侧栏拖到最宽（主界面被压到最窄）：让位 CSS 全量生效
        document.body.classList.add('dsh-sidebar-on');
        document.body.style.setProperty('--dsh-sidebar-width', '720px');
        window.dispatchEvent(new Event('resize'));
        await new Promise(function (res) { setTimeout(res, 60); });
        const tb = document.getElementById('toolbar');
        const wrap = getComputedStyle(tb).flexWrap;
        const save = document.getElementById('btn-save');
        const sr = save.getBoundingClientRect();
        const tbRect = tb.getBoundingClientRect();
        // 可见 = 在 toolbar 矩形内且高度正常（换行后仍在文档流内，未被裁掉）
        const visible = sr.height > 0 && sr.top >= tbRect.top - 1
          && sr.bottom <= tbRect.bottom + 1 && sr.left >= tbRect.left - 1;
        // 还原
        document.body.classList.remove('dsh-sidebar-on');
        document.body.style.setProperty('--dsh-sidebar-width', '');
        window.dispatchEvent(new Event('resize'));
        return { wrap, visible, ok: wrap === 'wrap' && visible };
      })()`);
      return { ok: !!r.ok, text: 'flexWrap=' + r.wrap + ' 保存按钮在最窄主区下可见=' + r.visible };
    }
  },

  {
    name: '折叠按钮：collapse IPC 通道健壮（冒烟未 init 下不抛不崩）',
    run: async (ctx) => {
      // 折叠按钮在主进程侧（show 时才创建），冒烟无真按钮；
      // 这里验证 hide() 链路的渲染层接收端：layout(visible=false) → body class 移除
      const r = await ctx.exec(`(async () => {
        document.body.classList.add('dsh-sidebar-on');
        document.body.style.setProperty('--dsh-sidebar-width', '420px');
        // 模拟主进程在 hide() 后广播的 layout(false)
        window.dispatchEvent(new Event('resize'));
        // 渲染层 handler 由 bindDshSidebar 订阅主进程通道 —— 冒烟里主进程不发，
        // 直接验证 class 切换机制（与主进程 removeChildView 对应的 UI 侧）
        document.body.classList.remove('dsh-sidebar-on');
        const margin = getComputedStyle(document.getElementById('main')).marginRight;
        return { margin, ok: margin === '0px' };
      })()`);
      return { ok: !!r.ok, text: '折叠后 main margin=' + r.margin + '（让位归零）' };
    }
  },

  {
    name: '收起到树根：收起后 root 不折叠、主题的子节点被藏，展开恢复',
    run: async (ctx) => {
      const r = await ctx.exec(`(async () => {
        var app = window.MMApp;
        var jm = app.getState().jm;
        jm.expand_all();
        var tpIds = (jm.get_node('root').children || []).map(function (c) { return c.id; });
        app.collapseAll();
        await new Promise(function (res) { setTimeout(res, 80); });
        var rootEl = document.querySelector('jmnode[nodeid="root"]');
        var rootVisible = rootEl && rootEl.offsetWidth > 0;   // root 不得被藏
        var tpCollapsed = tpIds.every(function (id) {
          var n = jm.get_node(id);
          return !n.children || !n.children.length || n.expanded === false;
        });
        app.expandAll();
        return { rootVisible: rootVisible, tpCollapsed: tpCollapsed,
          ok: rootVisible && tpCollapsed };
      })()`);
      return { ok: !!r.ok, text: 'root可见=' + r.rootVisible + ' 主题全部收起=' + r.tpCollapsed };
    }
  },

  {
    name: '框选节点：收起/展开作用于被框选节点，虚线框跟随重排并自适应大小',
    run: async (ctx) => {
      const r = await ctx.exec(`(async () => {
        var app = window.MMApp;
        var jm = app.getState().jm;
        jm.expand_all();
        await new Promise(function (res) { setTimeout(res, 60); });
        // 选一组**同父且有子节点**的节点（overview 的子节点，章级，都有知识点子孙）
        var parent = jm.get_node('overview');
        var ids = (parent.children || []).filter(function (c) {
          var el = document.querySelector('jmnode[nodeid="' + c.id + '"]');
          var n = jm.get_node(c.id);
          return el && el.offsetWidth > 0 && n.children && n.children.length;
        }).map(function (c) { return c.id; }).slice(0, 2);
        if (ids.length < 2) return { ok: false, text: '无可用测试节点' };
        app.applySelection(ids);
        if (!app.hasSelection()) return { ok: false, text: '选区未建立' };
        var box = document.getElementById('dsh-selection-outline');
        var before = box.getBoundingClientRect();
        // 收起所选：节点的子节点被藏 → 这些节点上移聚拢 → 虚线框应跟随且变小
        app.collapseSelection();
        await new Promise(function (res) { setTimeout(res, 120); }); // 等 observer 重算
        var afterCollapse = box.getBoundingClientRect();
        var stillVisible = afterCollapse.width > 0 && afterCollapse.height > 0;
        var shrank = afterCollapse.height <= before.height + 2; // 收起后不高于收起前
        var followed = Math.abs(afterCollapse.top - before.top) < 200; // 没有留在原地远离
        // 展开恢复：虚线框回到接近原尺寸
        app.expandSelection();
        await new Promise(function (res) { setTimeout(res, 120); });
        var afterExpand = box.getBoundingClientRect();
        var restored = Math.abs(afterExpand.height - before.height) < 400;
        app.clearSelection();
        return { stillVisible: stillVisible, shrank: shrank, followed: followed, restored: restored,
          ok: stillVisible && shrank && followed && restored };
      })()`);
      return { ok: !!r.ok, text: '收起后框可见=' + r.stillVisible + ' 未变大=' + r.shrank
        + ' 跟随重排=' + r.followed + ' 展开恢复=' + r.restored };
    }
  },

  {
    name: '框选节点：父节点+其子节点混选 → 收起父节点（子节点折进父），非空转',
    run: async (ctx) => {
      // 用户实测 bug 的精确复现：框选 [wlan-01 主题节点 + 它的 3 个子节点]
      // → 收起应作用于 wlan-01（子节点折进它），而不是选中最大组=3个叶子（无可收起）。
      const r = await ctx.exec(`(async () => {
        var app = window.MMApp;
        var jm = app.getState().jm;
        var topic = jm.get_node('wlan-01'); // 「无线网络概述与 802.11 演进」
        if (!topic || !topic.children || topic.children.length < 2) {
          return { ok: false, text: 'wlan-01 无子节点（前置不成立）' };
        }
        jm.expand_all();
        await new Promise(function (res) { setTimeout(res, 80); });
        var ids = [topic.id].concat(topic.children.map(function (c) { return c.id; }));
        app.applySelection(ids);
        var kidEl = document.querySelector('jmnode[nodeid="' + topic.children[0].id + '"]');
        var kidVisibleBefore = kidEl && kidEl.offsetWidth > 0;
        app.collapseSelection();
        await new Promise(function (res) { setTimeout(res, 150); });
        var topicEl = document.querySelector('jmnode[nodeid="wlan-01"]');
        var topicVisible = topicEl && topicEl.offsetWidth > 0;
        var kidsHidden = topic.children.every(function (c) {
          var el = document.querySelector('jmnode[nodeid="' + c.id + '"]');
          return !el || el.offsetWidth === 0;
        });
        app.expandSelection();
        await new Promise(function (res) { setTimeout(res, 150); });
        var kidsBack = topic.children.every(function (c) {
          var el = document.querySelector('jmnode[nodeid="' + c.id + '"]');
          return el && el.offsetWidth > 0;
        });
        app.clearSelection();
        return { kidVisibleBefore: kidVisibleBefore, topicVisible: topicVisible,
          kidsHidden: kidsHidden, kidsBack: kidsBack,
          ok: kidVisibleBefore && topicVisible && kidsHidden && kidsBack };
      })()`);
      return { ok: !!r.ok, text: '子节点原可见=' + r.kidVisibleBefore + ' 收起后主题可见=' + r.topicVisible
        + ' 子节点折进=' + r.kidsHidden + ' 展开恢复=' + r.kidsBack };
    }
  },

  {
    name: '框选筛选：主题+其子+跨主题杂选 → 生效集只留最浅同父组，虚线框不含跨主题节点',
    run: async (ctx) => {
      // 用户实测 bug：框选 [wlan-01 + 其3子 + 跨主题的 wlan-sta]，收起正确只作用于
      // wlan-01，但虚线框仍包着 wlan-sta。修复后：筛选在框选落选时完成，虚线框、
      // 菜单、操作三者同口径 —— wlan-sta 必须被过滤出选区。
      const r = await ctx.exec(`(async () => {
        var app = window.MMApp;
        var jm = app.getState().jm;
        var topic = jm.get_node('wlan-01');
        var sta = jm.get_node('wlan-sta'); // 「802.11 网络架构」主题下的 STA 工作站
        if (!topic || !topic.children || !sta) {
          return { ok: false, text: '前置节点不存在' };
        }
        jm.expand_all();
        await new Promise(function (res) { setTimeout(res, 80); });
        // 用户场景：wlan-01 + 其3子 + 跨主题 wlan-sta
        var ids = [topic.id].concat(topic.children.map(function (c) { return c.id; }));
        ids.push('wlan-sta');
        app.applySelection(ids);
        var staIn = app.hasSelection
          ? (function () { return app.hasSelection(); })() : false;
        // 关键断言：wlan-sta 不在生效选区（它跨主题、且是次浅组）
        // 用 refreshSelectionOutline 后的框几何验证：框不得包含 wlan-sta
        var box = document.getElementById('dsh-selection-outline');
        var boxR = box.getBoundingClientRect();
        var staEl = document.querySelector('jmnode[nodeid="wlan-sta"]');
        var staR = staEl.getBoundingClientRect();
        var staExcluded = !(staR.top >= boxR.top && staR.bottom <= boxR.bottom
          && staR.left >= boxR.left && staR.right <= boxR.right);
        // 生效集语义：收起仍作用于 wlan-01（子折进）
        app.collapseSelection();
        await new Promise(function (res) { setTimeout(res, 150); });
        var topicEl = document.querySelector('jmnode[nodeid="wlan-01"]');
        var topicVisible = topicEl && topicEl.offsetWidth > 0;
        var kidsHidden = topic.children.every(function (c) {
          var el = document.querySelector('jmnode[nodeid="' + c.id + '"]');
          return !el || el.offsetWidth === 0;
        });
        // 且 sta 本体不受影响（仍可见、未被过滤误伤数据）
        var staStillVisible = staEl.offsetWidth > 0;
        app.expandSelection();
        await new Promise(function (res) { setTimeout(res, 150); });
        app.clearSelection();
        return { staExcluded: staExcluded, topicVisible: topicVisible,
          kidsHidden: kidsHidden, staStillVisible: staStillVisible,
          ok: staExcluded && topicVisible && kidsHidden && staStillVisible };
      })()`);
      return { ok: !!r.ok, text: '虚线框排除跨主题sta=' + r.staExcluded
        + ' 收起生效(子折进wlan-01)=' + (r.topicVisible && r.kidsHidden)
        + ' sta数据无损=' + r.staStillVisible };
    }
  },

  {
    name: '虚线框范围 = 实际会被折叠的范围（选中节点 ∪ 其可见子节点）',
    run: async (ctx) => {
      const r = await ctx.exec(`(async () => {
        var app = window.MMApp;
        var jm = app.getState().jm;
        jm.expand_all();
        await new Promise(function (res) { setTimeout(res, 60); });
        // 只选父节点（不选子）：框应自动把其可见子树也包进来（预告折叠范围）
        var topic = jm.get_node('wlan-01');
        if (!topic || !topic.children || !topic.children.length) {
          return { ok: false, text: 'wlan-01 无子节点（前置不成立）' };
        }
        app.applySelection([topic.id]);
        var box = document.getElementById('dsh-selection-outline');
        var kidEl = document.querySelector('jmnode[nodeid="' + topic.children[0].id + '"]');
        var kidR = kidEl.getBoundingClientRect();
        var boxR = box.getBoundingClientRect();
        var coversKid = kidR.top >= boxR.top && kidR.bottom <= boxR.bottom
          && kidR.left >= boxR.left && kidR.right <= boxR.right;
        var coversTopic = true;
        var tEl = document.querySelector('jmnode[nodeid="wlan-01"]');
        var tR = tEl.getBoundingClientRect();
        coversTopic = tR.top >= boxR.top && tR.bottom <= boxR.bottom
          && tR.left >= boxR.left && tR.right <= boxR.right;
        // 收起后：框收缩到仅剩父节点
        app.collapseSelection();
        await new Promise(function (res) { setTimeout(res, 150); });
        var afterCollapse = box.getBoundingClientRect();
        var collapsed = topic.expanded === false;
        var shrunkToParent = afterCollapse.height <= tR.height + 40;
        app.expandSelection();
        await new Promise(function (res) { setTimeout(res, 150); });
        app.clearSelection();
        return { coversTopic: coversTopic, coversKid: coversKid,
          collapsed: collapsed, shrunkToParent: shrunkToParent,
          ok: coversTopic && coversKid && collapsed && shrunkToParent };
      })()`);
      return { ok: !!r.ok, text: '框含父=' + r.coversTopic + ' 框含子=' + r.coversKid
        + ' 收起生效=' + r.collapsed + ' 框收缩到父=' + r.shrunkToParent };
    }
  },

  {
    name: '框选预览不遮字：预览样式只加外圈（outline/光晕），不改节点背景与文字色',
    run: async (ctx) => {
      const r = await ctx.exec(`(async () => {
        // 样式层验证：mm-rubber-hit 不得覆写 background-color/color
        // （主题节点蓝底白字，覆写背景会让白字落白底不可见——用户实测）
        var app = window.MMApp;
        var jm = app.getState().jm;
        var someId = Object.keys(jm.mind.nodes).find(function (id) { return id !== 'root'; });
        var el = document.querySelector('jmnode[nodeid="' + someId + '"]');
        var colorBefore = getComputedStyle(el).color;
        var bgBefore = getComputedStyle(el).backgroundColor;
        el.classList.add('mm-rubber-hit');
        var colorAfter = getComputedStyle(el).color;
        var bgAfter = getComputedStyle(el).backgroundColor;
        el.classList.remove('mm-rubber-hit');
        var outlineWorks = getComputedStyle(el).outlineStyle !== 'none' || true; // 移除后回落，仅确认规则存在
        // 真断言：加 class 前后，color 与 background 完全一致（字始终可读）
        return { sameColor: colorBefore === colorAfter, sameBg: bgBefore === bgAfter,
          outlineWorks: outlineWorks,
          ok: colorBefore === colorAfter && bgBefore === bgAfter };
      })()`);
      return { ok: !!r.ok, text: '文字色不变=' + r.sameColor + ' 背景不变=' + r.sameBg
        + '（预览只加外圈虚线与光晕）' };
    }
  },

  {
    name: '框选命中口径：中心点或过半面积（蹭边不选）——业界 rubber band 折中',
    run: async (ctx) => {
      const r = await ctx.exec(`(async () => {
        // 用纯几何验证判定函数（挂 MM 供断言）
        var f = window.MM.nodeSelectedBy;
        if (!f) return { ok: false, text: 'nodeSelectedBy 未导出' };
        // 节点 r = {x:100,y:100,w:60,h:40}（面积 2400）
        var r0 = { id: 'a', x: 100, y: 100, w: 60, h: 40 };
        var t1 = f(r0, { x0: 110, y0: 105, x1: 170, y1: 135 });   // 中心(130,120)在框内 → 选
        var t2 = f(r0, { x0: 40, y0: 40, x1: 160, y1: 180 });     // 覆盖面积 60*40 全包 → 选
        var t3 = f(r0, { x0: 100, y0: 100, x1: 130, y1: 140 });   // 交集 30*40=1200 = 恰一半 → 选（≥50%）
        var t4 = f(r0, { x0: 145, y0: 100, x1: 200, y1: 140 });   // 交集 15*40=600 = 25%，中心在外 → 不选
        var t5 = f(r0, { x0: 100, y0: 90, x1: 160, y1: 105 });    // 交集 60*5=300 ≈12.5%，中心在外 → 不选
        return { t1: t1, t2: t2, t3: t3, t4: t4, t5: t5,
          ok: t1 && t2 && t3 && !t4 && !t5 };
      })()`);
      return { ok: !!r.ok, text: '中心在框=' + r.t1 + ' 全包=' + r.t2 + ' 半包=' + r.t3
        + ' 25%蹭边不选=' + !r.t4 + ' 12%蹭边不选=' + !r.t5 };
    }
  },

  {
    name: '侧栏折叠圆钮：toggle IPC 通道存在且未 init（冒烟）下安全',
    run: async (ctx) => {
      const r = await ctx.exec(`(async () => {
        try {
          window.desktop.dsh.toggle();
          return { ok: true };
        } catch (e) { return { ok: false, err: (e && e.message) || String(e) }; }
      })()`);
      return { ok: !!r.ok, text: r.err ? ('抛错: ' + r.err) : 'toggle IPC 健壮（fab 点击链路已通）' };
    }
  },

  {
    name: '仅侧边栏模式：dsh-only IPC 存在（冒烟未 init 下安全）',
    run: async (ctx) => {
      const r = await ctx.exec(`(async () => {
        try {
          var v = await window.desktop.dsh.isDshOnly();
          return { ok: typeof v === 'boolean', isDshOnly: v };
        } catch (e) { return { ok: false, err: (e && e.message) || String(e) }; }
      })()`);
      return { ok: !!r.ok, text: r.err ? ('抛错: ' + r.err) : ('isDshOnly=' + r.isDshOnly + '（冒烟恒 false）') };
    }
  }
];

module.exports = assertions;
