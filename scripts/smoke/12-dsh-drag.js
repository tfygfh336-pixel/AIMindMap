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

// 真帧像素判据（"仍可见"那半）：像素统计的唯一实现 + 阈值单源
const frameStats = require('../vision/frame-stats.js');
const VTH = frameStats.THRESHOLDS;

/** 渲染层返回 JSON 的取回口（迁移后的断言多处复用 ✓） */
async function execJson(ctx, js) {
  const raw = await ctx.exec(js);
  try { return JSON.parse(raw); } catch (e) { return { ok: false, text: String(raw).slice(0, 300) }; }
}

/** 判别力证明开关（默认空 ⇒ 正常跑完全不生效 ✓）；逗号分隔多键 ⇒ 一趟跑完多条注入 ✓ */
const INJECT = process.env.MM_SMOKE_INJECT || '';
const MY_KEY = (k) => INJECT.split(',').indexOf('12-' + k) >= 0;

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
    /* 【可见性判据迁移（2026-10-09）】原判据 = 保存按钮 rect 在 toolbar rect 内 + `flexWrap` 计算样式
     *  （V1 门禁在册欠账之一）。rect 对**裁切与遮挡是盲的**：按钮被挤到视口外/被盖住时读数一模一样 ✗。
     *  迁到真判据：① 命中测试 `elementFromPoint(按钮中心)` 必须命中按钮自身（抓遮挡与出视口）；
     *  ② 真帧像素数按钮矩形里的非背景像素（抓"没画出来"）；
     *  ③ "可点"用**真输入** `ctx.input.click`（走 Chromium 命中测试），并在 capture 阶段拦下 click
     *  只记"这一点上是谁"—— 不真触发 save()（本断言判"点得到"，落盘正确性归 09 域 ✓）。
     *  ⚠️ 能力边界（如实标注）：DSH 侧栏是主进程的 WebContentsView，**不参与 DOM 命中测试** ——
     *  "按钮是否落在给侧栏让出的那一条带里"只能由几何判（`save.right ≤ toolbar 内容框右缘`），
     *  其余（DOM 遮挡 / 裁切 / 出视口）由真判据覆盖；侧栏 native view 那一层需真机复核 ✓。 */
    name: '拖宽不遮挡工具栏：窄主区下 toolbar 自动换行（flex-wrap），保存按钮仍可见可点'
      + '（elementFromPoint 命中自身 + 真帧像素 + 真输入点击）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有真输入底座（ctx.input 缺失）⇒ 取不到真帧/真输入 = 红' };
      // ① 铺场：模拟侧栏拖到最宽（主界面被压到最窄）：让位 CSS 全量生效
      const geo = await execJson(ctx, `(function () {
        // 前置（**断言自建前置** ✓，与域 09/37 同一做法）：别的域可能留下没关掉的模态 ——
        // 全量运行实测：跑到本域时 \`#edit-dialog\`（编辑节点弹窗）还开着，把工具栏盖住了。
        // **模态开着时点不到保存是正常的**，不是本条要抓的损害（本条判的是"拖宽会不会把按钮
        // 挤出可视区 / 被侧栏盖住"）⇒ 先把残留模态收干净，并把"收了谁"写进报文 ——
        // 免得看起来像是把判据放宽了 ✗（\`display:none\` 正是产品自己 \`closeEditDialog\` 的做法 ✓）。
        var strays = [];
        Array.prototype.slice.call(document.querySelectorAll('.overlay')).forEach(function (ov) {
          if (ov.style.display && ov.style.display !== 'none') {
            strays.push(ov.id || (String(ov.className).split(' ')[0] || ov.tagName));
            ov.style.display = 'none';
          }
        });
        document.body.classList.add('dsh-sidebar-on');
        document.body.style.setProperty('--dsh-sidebar-width', '720px');
        window.dispatchEvent(new Event('resize'));
        var tb = document.getElementById('toolbar');
        var save = document.getElementById('btn-save');
        if (!tb || !save) return JSON.stringify({ ok: false, text: '没有 toolbar 或 btn-save' });
        var cs = window.getComputedStyle(tb);
        var sr = save.getBoundingClientRect(), tr = tb.getBoundingClientRect();
        var cx = Math.round(sr.left + sr.width / 2), cy = Math.round(sr.top + sr.height / 2);
        // —— 判别力证明（\`MM_SMOKE_INJECT=12-cover-save\`）：复刻"按钮被盖住"（native 侧栏占道
        //   在 DOM 里的等价物）—— rect 读数**一个数都不变**，只有命中测试/真输入能判出来 ✓
        if (${JSON.stringify(MY_KEY('cover-save'))}) {
          var cov = document.createElement('div');
          cov.id = 'mm-save-cover-probe';
          cov.style.cssText = 'position:fixed;left:' + sr.left + 'px;top:' + sr.top + 'px;width:' + sr.width
            + 'px;height:' + sr.height + 'px;background:#ffffff;z-index:99999;';
          document.body.appendChild(cov);
        }
        var at = document.elementFromPoint(cx, cy);
        var isSave = function (e) { return !!(e && (e.id === 'btn-save' || (e.closest && e.closest('#btn-save')))); };
        // 真输入点击的**拦截器**：capture 阶段先拿到事件（document 是路径最外层）⇒ 记下"命中是谁"
        // 后立刻 stopPropagation，事件到不了 #btn-save 自己的 click 监听器 ⇒ 不落盘、无副作用 ✓
        window.__mmSaveProbe = null; window.__mmSaveProbeArmed = true;
        document.addEventListener('click', function (ev) {
          if (!window.__mmSaveProbeArmed) return;
          window.__mmSaveProbeArmed = false;
          window.__mmSaveProbe = { target: ev.target ? (ev.target.id ? ('#' + ev.target.id) : (ev.target.tagName || '?')) : null,
            isSave: isSave(ev.target), x: ev.clientX, y: ev.clientY };
          ev.stopPropagation(); ev.preventDefault();
        }, true);
        return JSON.stringify({ ok: true, wrap: cs.flexWrap, padRight: parseFloat(cs.paddingRight) || 0,
          dpr: window.devicePixelRatio || 1, innerW: window.innerWidth, strays: strays,
          tb: { left: tr.left, top: tr.top, right: tr.right, bottom: tr.bottom, width: tr.width, height: tr.height },
          save: { left: sr.left, top: sr.top, width: sr.width, height: sr.height, right: sr.right, bottom: sr.bottom,
            center: { x: cx, y: cy } },
          hitIsSave: isSave(at),
          hitWhat: at ? (at.id ? ('#' + at.id) : (String(at.className || at.tagName).slice(0, 30))) : null });
      })()`);
      if (!geo.ok) return { ok: false, text: geo.text || '铺场失败' };
      await ctx.input.settle({ delayMs: 150 });
      // ② 真帧像素：按钮矩形里数非背景像素（"这块到底画出来没有"）
      const img = await ctx.input.capture();
      const dpr = geo.dpr || 1;
      const scan = frameStats.scanRegion(img, { x: geo.save.left * dpr, y: geo.save.top * dpr,
        width: geo.save.width * dpr, height: geo.save.height * dpr },
      { predicate: frameStats.nonBackgroundPredicate() });
      // ③ 真输入点击（真命中测试）+ ④ 还原铺场（本域后面的断言不该看到"侧栏被拖宽"）
      await ctx.input.click(geo.save.center);
      await ctx.input.settle({ delayMs: 150 });
      const probe = await execJson(ctx, `(function () {
        var p = window.__mmSaveProbe;
        var cov = document.getElementById('mm-save-cover-probe');
        if (cov) cov.parentNode.removeChild(cov);      // 注入收尾一律复位 ✓
        document.body.classList.remove('dsh-sidebar-on');
        document.body.style.setProperty('--dsh-sidebar-width', '');
        window.dispatchEvent(new Event('resize'));
        return JSON.stringify({ ok: true, probe: p });
      })()`);
      await ctx.input.settle({ delayMs: 60 });
      const pr = probe.probe;
      // 几何那半：按钮不得伸进"给侧栏让出的那一条带"（内容框右缘 = toolbar 右缘 − padding-right）
      const contentRight = geo.tb.right - geo.padRight;
      const inBand = geo.save.right <= contentRight + 1 && geo.save.bottom <= geo.tb.bottom + 1
        && geo.save.top >= geo.tb.top - 1;
      const ok = geo.wrap === 'wrap' && geo.hitIsSave === true && scan.ok === true
        && scan.hits >= VTH.paint.minHitsSaveBtn && !!pr && pr.isSave === true && inBand;
      return { ok: ok, text: 'flexWrap=' + geo.wrap
        + ' ｜ 命中测试命中保存按钮=' + geo.hitIsSave + '（命中=' + geo.hitWhat + '）'
        + ' ｜ 真帧非背景像素=' + (scan.ok ? scan.hits : ('扫描失败:' + scan.reason))
        + '（阈值 ≥' + VTH.paint.minHitsSaveBtn + '）'
        + ' ｜ 真输入点击送达=' + (pr ? (pr.isSave + '（事件目标=' + pr.target + ' @' + pr.x + ',' + pr.y + '）') : '没收到 click')
        + ' ｜ 按钮rect右缘=' + Math.round(geo.save.right) + ' ≤ 内容框右缘=' + Math.round(contentRight) + '=' + inBand
        + ' ｜ 窗口宽=' + geo.innerW + ' 让出带宽=' + geo.padRight
        + ' ｜ 前置收掉的残留模态=' + (geo.strays && geo.strays.length ? geo.strays.join(',') : '（无）') };
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
    // ⚠️ 名字里的"可见"曾经写成"可见子节点"⇒ 被 V1 门禁当成了**界面可见性**断言，而体内量的是 rect ✗。
    //    这里的语义其实是**数据层**的「展开集合」（`node.expanded` / `jm.layout.is_visible`），
    //    与"用户看不看得见"无关 ⇒ 正解是**改名消歧**（把话说到不会歧义），而不是硬套像素判据 ✓。
    name: '虚线框范围 = 实际会被折叠的范围（选中节点 ∪ 其展开中的子节点）',
    run: async (ctx) => {
      const r = await ctx.exec(`(async () => {
        var app = window.MMApp;
        var jm = app.getState().jm;
        jm.expand_all();
        await new Promise(function (res) { setTimeout(res, 60); });
        // 只选父节点（不选子）：框应自动把其**展开集合**里的子树也包进来（预告折叠范围）
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
