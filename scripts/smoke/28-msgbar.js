/* ============================================================
 * scripts/smoke/28-msgbar.js — 下方消息栏（功能 5a 入口③）
 * ------------------------------------------------------------
 * 用户原话：「在下方消息栏（显示发送消息框的地方）上方有一些虚体字，写
 *   『或者你可以直接向我描述要导入什么』，如果用户向里输入，就认为用户在向内嵌 DSH 发送提示词，
 *   自动补充情境信息」✓ 本域验三件：
 *   1) 消息栏在、**虚体字提示就是那句话**（一字不差 —— 用户能一眼认出这是他要的那个入口 ✓）
 *   2) 输入 + Enter ⇒ 打开**项目级** AI 浮窗（标题是项目名，不是节点名 ✓）并拿到答案（冒烟桩）
 *   3) 空输入 ⇒ 什么都不发生（不许发一个空提示词出去 ✗）
 *
 * 情境（当前项目 / 可用 CLI / 没选中节点）由 CLI 侧补齐 ⇒ 那一层由集成断言验（ask --dry-run）✓
 * 本域只管"界面这条链通不通"，且**不调用模型**（冒烟里 app:ask 返回 stub:true 的桩 ✓）。
 * ============================================================ */
'use strict';

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

module.exports = [
  {
    name: '消息栏：在、有虚体字「或者你可以直接向我描述要导入什么」（一字不差），且输入行可用',
    run: async (ctx) => {
      const res = await execJson(ctx, `(function () {
        var bar = document.getElementById('msg-bar');
        var hint = document.getElementById('msg-hint');
        var input = document.getElementById('msg-input');
        var btn = document.getElementById('msg-send');
        if (!bar || !hint || !input || !btn) return JSON.stringify({ ok: false, text: '消息栏元素不齐' });
        var r = bar.getBoundingClientRect();
        var visible = r.width > 100 && r.height > 10 && r.bottom <= window.innerHeight + 1;
        var color = getComputedStyle(hint).color;
        return JSON.stringify({
          ok: visible && hint.textContent === '或者你可以直接向我描述要导入什么',
          text: '可见=' + visible + ' 提示文案=' + JSON.stringify(hint.textContent)
            + ' 颜色=' + color + ' 位置=(' + Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + 'x' + Math.round(r.height) + ')'
        });
      })()`);
      return { ok: !!res.ok, text: res.text };
    }
  },
  {
    name: '消息栏：输入一句 + Enter ⇒ 打开**项目级** AI 浮窗（标题是项目名）并拿到回答（冒烟桩）',
    run: async (ctx) => {
      const q = '把 D:\\某处\\一本书.md 导入成新项目';
      await ctx.exec(`(function () {
        var input = document.getElementById('msg-input');
        input.value = ${JSON.stringify(q)};
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return 1;
      })()`);
      const res = await waitFor(ctx, `(function () {
        var project = (window.MMApp.getState().project || {}).name || '?';
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.float-detail[data-kind="ask"]'));
        if (!boxes.length) return JSON.stringify({ ok: false, text: '没有问答浮窗' });
        var box = boxes[boxes.length - 1];
        var title = (box.querySelector('.fd-title') || {}).textContent || '';
        var text = box.textContent || '';
        var input = box.querySelector('.ask-input');
        return JSON.stringify({
          ok: title === ('AI 助手 · ' + project) && text.indexOf(${JSON.stringify(q)}) >= 0
            && text.indexOf('回答占位') >= 0 && !!box.querySelector('.ask-stub') && !!input,
          text: '标题=「' + title + '」（应为「AI 助手 · ' + project + '」）含我的问题=' + (text.indexOf(${JSON.stringify(q)}) >= 0)
            + ' 含回答=' + (text.indexOf('回答占位') >= 0) + ' 桩标记=' + !!box.querySelector('.ask-stub')
            + ' 消息栏已清空=' + (document.getElementById('msg-input').value === '')
        });
      })()`);
      const o = JSON.parse(res);
      return { ok: !!o.ok, text: o.text };
    }
  },
  {
    name: '消息栏：空输入 + Enter ⇒ 不发（没有产生新的问答流水，也不是"发了空问题"）',
    run: async (ctx) => {
      const res = await execJson(ctx, `(function () {
        var before = document.querySelectorAll('.float-detail[data-kind="ask"] .ask-item').length;
        var input = document.getElementById('msg-input');
        input.value = '   ';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        var after = document.querySelectorAll('.float-detail[data-kind="ask"] .ask-item').length;
        return JSON.stringify({ ok: after === before, text: '流水条数 ' + before + ' → ' + after + '（不该变）' });
      })()`);
      return { ok: !!res.ok, text: res.text };
    }
  }
];
