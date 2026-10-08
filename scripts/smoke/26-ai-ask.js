/* ============================================================
 * scripts/smoke/26-ai-ask.js — 节点悬浮工具条 + AI 问答浮窗（功能 1 界面层）
 * ------------------------------------------------------------
 * 覆盖三条（**全链路**，但**不调用模型**）：
 *   1) 选中节点 ⇒ 悬浮工具条出现，贴着该节点，且两个按钮（解释 / 问问AI）齐备
 *   2) 点「解释」⇒ 弹出浮窗（复用节点详情框组件）、标题含该节点标题、正文出现答案
 *      —— 冒烟里 `app:ask` 返回**桩**（`stub:true`，见 main.js），所以这里断言的是"链路通不通"；
 *      桩必须在界面上**可见地标出来**（`.ask-stub`），否则人会把占位文案当成真答案 ✗
 *   3) 「问问AI」⇒ 浮窗里有输入行；输入问题回车 ⇒ 流水里出现"你问的"与回答
 *
 * 为什么门禁里绝不真调模型：一次解释实测 ~24s + 烧真实额度 + 依赖网络 —— 门禁里不做重活
 *（本工程的分层纪律）。真通道的验证在 `cli ask` 那一层做（集成断言验提示词，人工做真跑）。
 *
 * 数据：**运行时从界面自己的树里挑一个可见节点**（不写死 id —— 前面的域会删节点，写死必红 ✗）。
 * ============================================================ */
'use strict';

/** 在渲染层执行并解析 JSON */
async function execJson(ctx, js) {
  const raw = await ctx.exec(js);
  try { return JSON.parse(raw); } catch (e) { return { ok: false, text: String(raw).slice(0, 200) }; }
}

async function waitFor(ctx, js, tries) {
  let last = '';
  for (let i = 0; i < (tries || 40); i++) {
    last = await ctx.exec(js);
    try { if (JSON.parse(last).ok) return last; } catch (e) { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return last;
}

/** 挑一个**有真实几何**的节点（可见、可点击） */
async function pickVisibleNode(ctx) {
  return execJson(ctx, `(function () {
    var jm = window.MMApp.getState().jm, out = null;
    (function walk(n) {
      if (!n || out) return;
      if (n.id && n.id !== 'root') {
        var el = document.querySelector('jmnode[nodeid="' + n.id + '"]');
        if (el) {
          var r = el.getBoundingClientRect();
          if (r.width > 4 && r.height > 4) { out = { id: n.id, topic: n.topic }; return; }
        }
      }
      (n.children || []).forEach(walk);
    })(jm.get_node('root'));
    return JSON.stringify({ ok: !!out, text: out ? out.id : '找不到可见节点', node: out });
  })()`);
}

/** 前置：把**所有已打开的详情框关掉**再开始。
 *  ⚠️ 本域有两条断言栽在这上面（隔离跑红 / 全量跑绿 ⇒ 典型的状态依赖 ✗）：
 *  应用启动会**恢复上次打开的详情框**（.ui-state.json）⇒ 那个框的工具条会盖住"我刚选中的节点"，
 *  于是 `bar.dataset.node` 指向**恢复出来的节点**，与断言挑中的节点对不上 ✓。
 *  加上这条前置，断言就与实际数据形状无关了 ✓ */
async function closeAllBoxes(ctx) {
  await ctx.exec(`(function () {
    Array.prototype.slice.call(document.querySelectorAll('.float-detail .fd-close')).forEach(function (b) { b.click(); });
    return 1;
  })()`);
  await new Promise((r) => setTimeout(r, 200));
}

module.exports = [
  {
    name: 'AI 问答：选中节点 ⇒ 悬浮工具条出现（贴着该节点，两个按钮齐备）',
    run: async (ctx) => {
      const pick = await pickVisibleNode(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      const id = pick.node.id;
      await closeAllBoxes(ctx);          // ① 关掉"恢复出来的框"，否则工具条归它 ✗
      // ② （下一轮要做）确保该节点**真的有几何**：观察到工具条落到 (8,8) 且 data-node 指向另一个
      //    节点 ⇒ 说明被选中的节点当时几何为 0（祖先折叠 / 恢复出来的框抢走工具条）。
      //    我本轮试过在页面里 expand+layout，**注入抛错**（jm 的 API 形态与假设不符）⇒ 先撤回，
      //    留给下一轮用正确 API 做，别在这里留一个会抛错的注入 ✗
      await ctx.exec(`(function () {
        var app = window.MMApp, jm = app.getState().jm;
        app.showDetail(jm.get_node(${JSON.stringify(id)}));
        return 1;
      })()`);
      const res = await waitFor(ctx, `(function () {
        var bar = document.getElementById('mm-node-toolbar');
        if (!bar || bar.style.display === 'none') return JSON.stringify({ ok: false, text: '工具条没出现' });
        var ex = bar.querySelector('.mm-tb-explain'), ak = bar.querySelector('.mm-tb-ask');
        var el = document.querySelector('jmnode[nodeid="' + bar.getAttribute('data-node') + '"]');
        if (!el) return JSON.stringify({ ok: false, text: '工具条 data-node 指向的节点元素找不到' });
        var br = bar.getBoundingClientRect(), nr = el.getBoundingClientRect();
        var dx = Math.abs((br.left + br.width / 2) - (nr.left + nr.width / 2));
        var near = dx < 90 && br.top > 0 && br.top < window.innerHeight;
        return JSON.stringify({
          ok: !!ex && !!ak && near && bar.getAttribute('data-node') === ${JSON.stringify(id)},
          text: '按钮=' + (ex ? ex.textContent.trim() : '无') + '/' + (ak ? ak.textContent.trim() : '无')
            + ' 节点=' + bar.getAttribute('data-node') + ' 水平偏差=' + Math.round(dx) + 'px'
            + ' 工具条位置=(' + Math.round(br.left) + ',' + Math.round(br.top) + ')'
        });
      })()`);
      const o = JSON.parse(res);
      return { ok: !!o.ok, text: '挑中节点=' + id + ' ｜ ' + o.text };
    }
  },
  {
    name: 'AI 问答：点「解释」⇒ 浮窗复用详情框组件、标题含节点标题、正文出答案（冒烟桩，且标出来）',
    run: async (ctx) => {
      const pick = await pickVisibleNode(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      const id = pick.node.id, topic = pick.node.topic;
      await ctx.exec(`(function () {
        var bar = document.getElementById('mm-node-toolbar');
        if (!bar || bar.style.display === 'none') {
          window.MM.showNodeToolbar(${JSON.stringify(id)});
        }
        document.querySelector('#mm-node-toolbar .mm-tb-explain').click();
        return 1;
      })()`);
      const res = await waitFor(ctx, `(function () {
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail[data-kind="ask"]'));
        if (!boxes.length) return JSON.stringify({ ok: false, text: '没有 data-kind=ask 的浮窗' });
        var box = boxes[boxes.length - 1];
        var title = (box.querySelector('.fd-title') || {}).textContent || '';
        var text = box.textContent || '';
        // 复用详情框组件的证据：头部锁/关闭按钮与改大小把手都在（和节点详情同一套）
        var hasChrome = !!(box.querySelector('.fd-lock-map') && box.querySelector('.fd-lock-screen')
          && box.querySelector('.fd-close') && box.querySelector('.fd-rs-e'));
        var hasStub = !!box.querySelector('.ask-stub') && text.indexOf('未调用模型') >= 0;
        var hasAnswer = text.indexOf('解释占位') >= 0;
        // ① 答案里的 **粗体** 必须渲染成 <strong>（用户反馈"全局 ** 不渲染"的机械判据 ✓）
        var hasBold = !!box.querySelector('.ask-a strong');
        var hasList = !!box.querySelector('.ask-a li');
        var noVisLocks = (function () {
          var m = box.querySelector('.fd-lock-map'), s = box.querySelector('.fd-lock-screen');
          return (!m || getComputedStyle(m).display === 'none') && (!s || getComputedStyle(s).display === 'none');
        })();
        return JSON.stringify({
          ok: title.indexOf(${JSON.stringify(topic)}) >= 0 && hasChrome && hasStub && hasAnswer && hasBold && hasList && noVisLocks,
          text: '标题=「' + title + '」 复用详情框外壳=' + hasChrome + ' 有桩标记=' + hasStub + ' 有答案=' + hasAnswer
            + ' 粗体已渲染=' + hasBold + ' 列表已渲染=' + hasList + ' 大小锁已隐藏=' + noVisLocks
        });
      })()`);
      const o = JSON.parse(res);
      return { ok: !!o.ok, text: o.text };
    }
  },
  {
    name: 'AI 问答：「问问AI」⇒ 输入行可用；问一句 ⇒ 流水里有"我的问题"与回答（桩标记可见）',
    run: async (ctx) => {
      const pick = await pickVisibleNode(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      const id = pick.node.id;
      const q = '冒烟提问：这个节点为什么重要？';
      await ctx.exec(`(function () {
        window.MM.showAskBox(${JSON.stringify(id)}, { kind: 'ask' });
        return 1;
      })()`);
      const typed = await waitFor(ctx, `(function () {
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail[data-kind="ask"]'));
        var box = boxes[boxes.length - 1];
        if (!box) return JSON.stringify({ ok: false, text: '没有问答浮窗' });
        var input = box.querySelector('.ask-input');
        if (!input) return JSON.stringify({ ok: false, text: '没有输入行' });
        input.value = ${JSON.stringify(q)};
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return JSON.stringify({ ok: true, text: '已回车发送' });
      })()`);
      const o1 = JSON.parse(typed);
      if (!o1.ok) return { ok: false, text: o1.text };
      const res = await waitFor(ctx, `(function () {
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail[data-kind="ask"]'));
        var box = boxes[boxes.length - 1];
        var text = box ? box.textContent : '';
        var hasQ = text.indexOf(${JSON.stringify(q)}) >= 0;
        var hasA = text.indexOf('回答占位') >= 0;
        var stub = !!box.querySelector('.ask-stub');
        var noPending = !box.querySelector('.ask-pending');
        return JSON.stringify({ ok: hasQ && hasA && stub && noPending,
          text: '含问题=' + hasQ + ' 含回答=' + hasA + ' 桩标记=' + stub + ' 已结束等待=' + noPending });
      })()`);
      const o = JSON.parse(res);
      return { ok: !!o.ok, text: o.text };
    }
  },
  {
    name: 'AI 问答：工具条定位是纯几何（上/下方翻转 + 视口夹取）—— 直接判纯函数，不依赖某个节点的具体位置',
    run: async (ctx) => {
      const res = await execJson(ctx, `(function () {
        var f = window.MM.computeBarPos;
        if (!f) return JSON.stringify({ ok: false, text: '没导出 computeBarPos' });
        var view = { w: 800, h: 600 };
        // ① 正常：节点在中间 ⇒ 贴在它上边、水平居中
        var a = f({ left: 300, top: 300, width: 100, height: 40, right: 400, bottom: 340 }, 150, 30, view);
        // ② 贴近顶边 ⇒ 上方放不下 ⇒ **翻到下方**
        var b = f({ left: 300, top: 5, width: 100, height: 40, right: 400, bottom: 45 }, 150, 30, view);
        // ③ 贴近右边 ⇒ 水平**夹回**视口内（不能有一半在屏幕外）
        var c = f({ left: 770, top: 300, width: 100, height: 40, right: 870, bottom: 340 }, 150, 30, view);
        var ok = a.top === 262 && a.left === 275
          && b.top === 53
          && c.left === view.w - 150 - 8;
        return JSON.stringify({ ok: ok,
          text: '正常=' + JSON.stringify(a) + ' 上边翻转=' + JSON.stringify(b) + ' 右边夹取=' + JSON.stringify(c) });
      })()`);
      return { ok: !!res.ok, text: res.text };
    }
  },
  {
    name: 'AI 问答（用户反馈⑤⑧）：空框**不写"正在生成…"**、点别处即消失、位置钉在首次显示处',
    run: async (ctx) => {
      const pick = await pickVisibleNode(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      // ① 开一个**全新的**空框：先关掉前面断言留下的框（否则会**复用**那个已有流水的框，
      //    而"空框提示"只对真的空框成立 —— 我第一版就踩了这个前置条件 ✗）
      await ctx.exec(`(function () {
        Array.prototype.slice.call(document.querySelectorAll('.fd-ask-box .fd-close'))
          .forEach(function (b) { b.click(); });
        return 1;
      })()`);
      await new Promise((r) => setTimeout(r, 150));
      const opened = await execJson(ctx, `(function () {
        var box = window.MM.showAskBox(${JSON.stringify(pick.node.id)}, { kind: 'ask' });
        if (!box) return JSON.stringify({ ok: false, text: '没打开框' });
        var text = box.el.textContent || '';
        var empty = !!box.el.querySelector('.ask-empty');
        var pending = text.indexOf('正在生成') >= 0;
        return JSON.stringify({
          ok: empty && !pending,
          text: '有"请你先问"提示=' + empty + ' 出现"正在生成…"=' + pending
            + ' 位置=(' + Math.round(parseFloat(box.el.style.left) || 0) + ',' + Math.round(parseFloat(box.el.style.top) || 0) + ')',
          left: Math.round(parseFloat(box.el.style.left) || 0), top: Math.round(parseFloat(box.el.style.top) || 0)
        });
      })()`);
      if (!opened.ok) return { ok: false, text: opened.text };
      // ② 位置钉住：改视图变换（平移+缩放）后，框的位置**不该变**（= 大锁 = 绑定在首次显示处 ✓）
      const stayed = await execJson(ctx, `(function () {
        var el = document.querySelector('.fd-ask-box');
        if (!el) return JSON.stringify({ ok: false, text: '框不见了' });
        window.MM.setViewTransform({ s: 0.7, x: 120, y: 60 });
        var l = Math.round(parseFloat(el.style.left) || 0), t = Math.round(parseFloat(el.style.top) || 0);
        window.MM.setViewTransform({ s: 1, x: 0, y: 0 });
        return JSON.stringify({ ok: Math.abs(l - ${opened.left}) < 2 && Math.abs(t - ${opened.top}) < 2,
          text: '变换后位置=(' + l + ',' + t + ')，首显位置=(${opened.left},${opened.top})' });
      })()`);
      // ③ 点**别处**（导图空白处，真鼠标事件）⇒ 框消失（用户反馈⑧）
      const panel = await execJson(ctx, `(function () {
        var p = window.MM.fdPanel(); var r = p.getBoundingClientRect();
        return JSON.stringify({ ok: true, x: Math.round(r.left + 24), y: Math.round(r.bottom - 24) });
      })()`);
      ctx.win.webContents.sendInputEvent({ type: 'mouseMove', x: panel.x, y: panel.y });
      ctx.win.webContents.sendInputEvent({ type: 'mouseDown', x: panel.x, y: panel.y, button: 'left', clickCount: 1 });
      ctx.win.webContents.sendInputEvent({ type: 'mouseUp', x: panel.x, y: panel.y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 250));
      const gone = await execJson(ctx, `(function () {
        var n = document.querySelectorAll('.fd-ask-box').length;
        var bar = window.MM.isNodeToolbarVisible ? window.MM.isNodeToolbarVisible() : null;
        return JSON.stringify({ ok: n === 0, text: '剩下打开的 AI 框=' + n + ' 工具条可见=' + bar });
      })()`);
      return {
        ok: !!opened.ok && !!stayed.ok && !!gone.ok,
        text: opened.text + ' ｜ ' + stayed.text + ' ｜ ' + gone.text
      };
    }
  },
  {
    name: 'AI 问答：思考强度下拉（③）—— 在浮窗里能改，且真的送出去了',
    run: async (ctx) => {
      const pick = await pickVisibleNode(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      // 自己开一个（**不依赖上一条留下的状态**：上一条断言最后会点空白关掉所有框 —— 我又踩了一次顺序依赖 ✗）
      await ctx.exec(`window.MM.showAskBox(${JSON.stringify(pick.node.id)}, { kind: 'ask' }); 1`);
      await waitFor(ctx, `(function () {
        return JSON.stringify({ ok: !!document.querySelector('.fd-ask-box .ask-effort'), text: '等下拉出现' });
      })()`);
      const res = await execJson(ctx, `(function () {
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.fd-ask-box'));
        if (!boxes.length) return JSON.stringify({ ok: false, text: '没有已打开的问答框' });
        var sel = boxes[boxes.length - 1].querySelector('.ask-effort');
        if (!sel) return JSON.stringify({ ok: false, text: '输入行里没有 .ask-effort 下拉' });
        var opts = Array.prototype.slice.call(sel.options).map(function (o) { return o.value; });
        var before = sel.value;
        sel.value = 'high';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return JSON.stringify({ ok: opts.join(',') === 'low,medium,high,xhigh', text: '选项=' + opts.join(',')
          + ' 默认=' + before + ' ⇒ 改成 high', opts: opts });
      })()`);
      if (!res.ok) return { ok: false, text: res.text };
      // 真发一句：桩会把收到的强度回显（证明 下拉 → 主进程 这一跳通了 ✓；主进程→CLI 那跳由集成断言覆盖）
      await ctx.exec(`(function () {
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.fd-ask-box'));
        var box = boxes[boxes.length - 1];
        var input = box.querySelector('.ask-input');
        input.value = '强度测试问题';
        box.querySelector('.ask-send').click();
        return 1;
      })()`);
      const chk = await waitFor(ctx, `(function () {
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.fd-ask-box'));
        var box = boxes[boxes.length - 1];
        var text = box ? box.textContent : '';
        return JSON.stringify({ ok: text.indexOf('思考强度：high') >= 0,
          text: '桩回显含"思考强度：high"=' + (text.indexOf('思考强度：high') >= 0) });
      })()`);
      const o = JSON.parse(chk);
      return { ok: !!o.ok, text: res.text + ' ｜ ' + o.text };
    }
  },
  {
    name: '⑩「侧边栏」按钮：在浮窗里，且送不出去时**如实说出原因**（不静默失败 ✗）',
    run: async (ctx) => {
      const pick = await pickVisibleNode(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      await ctx.exec(`window.MM.showAskBox(${JSON.stringify(pick.node.id)}, { kind: 'ask' }); 1`);
      const waited = await waitFor(ctx, `(function () {
        return JSON.stringify({ ok: !!document.querySelector('.fd-ask-box .ask-to-sidebar'), text: '等按钮出现' });
      })()`);
      const res = await execJson(ctx, `(async function () {
        var box = document.querySelector('.fd-ask-box');
        var btn = box.querySelector('.ask-to-sidebar');
        if (!btn) return JSON.stringify({ ok: false, text: '按钮不存在' });
        var input = box.querySelector('.ask-input');
        input.value = '侧栏投喂测试问题';
        box.querySelector('.ask-send').click();                       // 先造一条对话（Q/A 都在）
        await new Promise(function (r) { setTimeout(r, 400); });
        btn.click();                                                  // 再点「侧边栏」
        await new Promise(function (r) { setTimeout(r, 600); });
        var status = (document.querySelector('#status-text') || {}).textContent || '';
        // 冒烟里没有真侧栏 ⇒ 预期是**如实报错**（不管是"没在运行"还是"找不到输入框"）✓
        // 硬判据：状态栏必须出现"没送进侧边栏：<原因>"，而不是什么都没说 ✗
        return JSON.stringify({
          ok: status.indexOf('没送进侧边栏：') >= 0 || status.indexOf('已送进侧栏输入框') >= 0,
          text: '状态栏=' + JSON.stringify(status.slice(0, 80))
            + ' ｜ 按钮存在=' + !!btn + ' ｜ 回复区=' + ((box.textContent || '').indexOf('侧栏投喂测试问题') >= 0)
        });
      })()`);
      return { ok: !!res.ok, text: JSON.parse(waited).text + ' ｜ ' + res.text };
    }
  },
  {
    name: '⑨ 工具条「⇥ 侧栏」：按钮在，且送不出去时**如实说原因**（不静默 ✗）',
    run: async (ctx) => {
      const pick = await pickVisibleNode(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      await closeAllBoxes(ctx);
      await ctx.exec(`(function () {
        var app = window.MMApp, jm = app.getState().jm, n = jm.get_node(${JSON.stringify(pick.node.id)});
        if (window.MM.showNodeToolbar) window.MM.showNodeToolbar(${JSON.stringify(pick.node.id)});
        return 1;
      })()`);
      const res = await execJson(ctx, `(async function () {
        var bar = document.getElementById('mm-node-toolbar');
        var btn = bar ? bar.querySelector('.mm-tb-side') : null;
        if (!btn) return JSON.stringify({ ok: false, text: '工具条上没有 .mm-tb-side 按钮' });
        btn.click();
        await new Promise(function (r) { setTimeout(r, 700); });
        var status = (document.querySelector('#status-text') || {}).textContent || '';
        // 冒烟里没有真侧栏 ⇒ 预期是**如实报错**；硬判据 = 状态栏必须给出结论（成功或原因）✓ 不能沉默 ✗
        return JSON.stringify({
          ok: /没送进侧边栏：|已把 \d+ 个节点送进侧栏输入框|正在送进侧栏/.test(status),
          text: '按钮文案="' + btn.textContent.trim() + '" ｜ 状态栏=' + JSON.stringify(status.slice(0, 70))
        });
      })()`);
      return { ok: !!res.ok, text: res.text };
    }
  },
  {
    name: '⑨ 拖拽入口：MM.sendNodesToSidebar 已导出（app-view 的树拖动松手处要调它），失败时如实报错',
    run: async (ctx) => {
      const pick = await pickVisibleNode(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      const res = await execJson(ctx, `(async function () {
        if (typeof window.MM.sendNodesToSidebar !== 'function') {
          return JSON.stringify({ ok: false, text: '没有导出 MM.sendNodesToSidebar（拖拽收尾会静默失败 ✗）' });
        }
        await window.MM.sendNodesToSidebar([${JSON.stringify(pick.node.id)}]);
        await new Promise(function (r) { setTimeout(r, 500); });
        var status = (document.querySelector('#status-text') || {}).textContent || '';
        return JSON.stringify({
          ok: /没送进侧边栏：|已把 \d+ 个节点送进侧栏输入框/.test(status),
          text: '导出=有 ｜ 状态栏=' + JSON.stringify(status.slice(0, 60))
        });
      })()`);
      // ⚠️ 诚实标注：这一条验的是"拖拽要调的那个入口"存在且会如实报结果 ✓；
      //    **手势接线本身**（拖动模式 + 在最右侧松手）目前**还没有断言覆盖** ✗ —— 需要知道怎么进拖动模式，
      //    留到下一轮补（不假装它已经被覆盖 ✓）
      return { ok: !!res.ok, text: res.text + '（手势接线本身待补断言 ✗）' };
    }
  }
];
