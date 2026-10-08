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

module.exports = [
  {
    name: 'AI 问答：选中节点 ⇒ 悬浮工具条出现（贴着该节点，两个按钮齐备）',
    run: async (ctx) => {
      const pick = await pickVisibleNode(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      const id = pick.node.id;
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
        return JSON.stringify({
          ok: title.indexOf(${JSON.stringify(topic)}) >= 0 && hasChrome && hasStub && hasAnswer,
          text: '标题=「' + title + '」 复用详情框外壳=' + hasChrome + ' 有桩标记=' + hasStub + ' 有答案=' + hasAnswer
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
  }
];
