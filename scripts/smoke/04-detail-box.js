/* ============================================================
 * scripts/smoke/04-detail-box.js —— 冒烟断言分域 04：浮动详情框的布局与锁定
 * （拖动改位 / 小锁随平移不变 / 小锁跨缩放偏移不变 / 大锁忽略平移 /
 *   多框共存 / 拖动自动上锁 / 详情框随缩放等比 / 悬停提示 / 区块顺序）
 *
 * 由入口 scripts/smoke-assertions.js 按顺序拼接执行。
 * 本文件是对拆分前单体 smoke-assertions.js 的逐字搬运，勿改断言文案与顺序。
 *
 * 【2026-10-26 追加三条】本文件的**最后三条**是「编辑节点详情**真的能输入**」
 * （用户原话「编辑节点详情功能有问题，不能输入，你的测试形同虚设」）。
 * 它们用 `ctx.input`（真鼠标 / 真键盘）而不设 `.value`，判别力证明见
 * `.review/20261045-编辑详情不能输入/`。为什么落在这个文件里：它跑在**主窗**上，
 * 而用户遇到的就是主窗那个对话框（`#edit-dialog` / `#edit-detail`）；
 * 草稿窗那份同型判据在域 56。
 * ============================================================ */
'use strict';
const WAIT = require('./_wait.js');   // 等真帧/等条件：理由见该文件头部第 5 条

/* ================= 「编辑节点详情」真输入的共用零件（**唯一实现**，三条断言都调这里） =================
 * 两条 token 都只用 ASCII 字母数字：`sendInputEvent({type:'char'})` 对 `<` `>` 这类字符
 * 依赖键盘布局，用它们会把"判据坏"与"输入法/布局不一样"混在一起（本工程最忌讳的混淆）。
 * 判据只看"这串字出现在哪里"，不看它在正文里的位置。 */
const TOKEN_INPUT = 'smokeRealInputQ7';
const TOKEN_DISK = 'smokeRealDiskQ7';
const TOKEN_ENTER = 'smokeRealEnterQ7';

/** 详情格 + 对话框 + 可用区的**一次读全**（`rect` / `elementFromPoint` / `--dsh-sidebar-width`）。
 *  ⚠️ 只读：这里没有一处写 DOM（写只发生在调用方明确要写的时候）。 */
const EDIT_GEO_JS = `(function () {
  var ta = document.getElementById('edit-detail');
  var dlg = document.getElementById('edit-dialog');
  var box = document.querySelector('#edit-dialog .dialog-box');
  if (!ta || !dlg || !box) return { ok: false, text: '缺 #edit-detail / #edit-dialog / .dialog-box' };
  var r = ta.getBoundingClientRect(), br = box.getBoundingClientRect();
  var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
  function tagOf(el) { return el ? (el.tagName + (el.id ? '#' + el.id : '')) : 'null'; }
  var at = cx > 0 && cy > 0 ? document.elementFromPoint(cx, cy) : null;
  var sideRaw = (getComputedStyle(document.body).getPropertyValue('--dsh-sidebar-width') || '').trim();
  var side = parseFloat(sideRaw) || 0;
  var vw = window.innerWidth, vh = window.innerHeight;
  var avail = vw - side;
  return {
    ok: true,
    open: dlg.style.display === 'flex',
    ta: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right),
          bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) },
    box: { left: Math.round(br.left), right: Math.round(br.right), width: Math.round(br.width) },
    vw: vw, vh: vh, sideRaw: sideRaw, side: side, avail: avail,
    center: { x: cx, y: cy }, at: tagOf(at), atIsTa: !!(at && at.id === 'edit-detail'),
    inWindow: r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh,
    edgeAt: tagOf(avail - 2 > 0 ? document.elementFromPoint(Math.round(avail - 2), cy) : null),
    farAt: tagOf(document.elementFromPoint(vw - 2, cy)),
    readOnly: !!ta.readOnly, disabled: !!ta.disabled,
    value: String(ta.value == null ? '' : ta.value)
  };
})()`;

/** 焦点 + 值（真输入前后各读一次；**判据只读这两样**） */
const READ_EDIT_STATE_JS = `(function () {
  var ta = document.getElementById('edit-detail');
  return {
    value: ta ? String(ta.value == null ? '' : ta.value) : '',
    active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : 'none',
    readOnly: !!(ta && ta.readOnly)
  };
})()`;

function fmtRect(r) {
  return '{' + r.left + ',' + r.top + ' ' + r.width + '×' + r.height + '}';
}

/** 两段文本的**插入段**（最长公共前缀 + 最长公共后缀夹出来的那一段）。
 *  为什么需要它：真键盘的插入发生在**光标处**（点格子中心 ⇒ 经常在正文中间），
 *  所以"末尾多了什么"根本不是这次的改动；取末尾只会读到原文的最后一个字符。 */
function diffInserted(a, b) {
  const A = String(a == null ? '' : a), B = String(b == null ? '' : b);
  let p = 0;
  while (p < A.length && p < B.length && A.charAt(p) === B.charAt(p)) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p
    && A.charAt(A.length - 1 - s) === B.charAt(B.length - 1 - s)) s++;
  return B.slice(p, B.length - s);
}

/** 确认项目开着（**只开**，不改内容）；单独跑本域时前面的域没跑 ⇒ 必须自建前置 */
async function ensureProjectOpen(ctx) {
  const r = await ctx.exec(`(async function () {
    try {
      var st = window.MMApp.getState();
      if (st && st.project && st.jm) return { ok: true, name: st.project.name, how: 'already' };
      if (window.MM.setConfirmStub) window.MM.setConfirmStub(function () { return true; });
      await Promise.race([
        Promise.resolve(window.MMApp.openProject('comnet')),
        new Promise(function (res) { setTimeout(function () { res(null); }, 15000); })
      ]);
      if (window.MM.setConfirmStub) window.MM.setConfirmStub(null);
      var now = window.MMApp.getState();
      return { ok: !!(now && now.project && now.jm), name: (now && now.project && now.project.name) || '', how: 'opened' };
    } catch (e) { return { ok: false, text: 'err:' + ((e && e.message) || e) }; }
  })()`);
  const o = (r && typeof r === 'object') ? r : { ok: false, text: String(r).slice(0, 160) };
  o.text = '项目=' + JSON.stringify(o.name) + '（' + (o.how || '?') + '）';
  return o;
}

/** 挑一个要编辑的节点并选中它（`tcp-handshake` 优先 —— 它是有正文的稳定样本；
 *  没有它才退到"第一个非根节点"，**不写死 id**：样本换了也不该让判据变成假绿）。 */
async function pickNodeForEdit(ctx) {
  const r = await ctx.exec(`(function () {
    var jm = window.MMApp.getState().jm;
    if (!jm) return { ok: false, text: '没有 jm（项目没开）' };
    var ids = Object.keys(jm.mind.nodes || {});
    var id = '';
    if (jm.get_node('tcp-handshake')) id = 'tcp-handshake';
    else { for (var i = 0; i < ids.length; i++) { if (String(ids[i]) !== 'root') { id = ids[i]; break; } } }
    if (!id) return { ok: false, text: '项目里没有非根节点' };
    if (window.MMApp.closeAllFloatDetail) window.MMApp.closeAllFloatDetail();
    window.MM.adapter.selectNode(jm, id);
    var sel = window.MM.adapter.getSelected(jm);
    var n = jm.get_node(id);
    var st = window.MMApp.getState();
    return { ok: !!(sel && String(sel.id) === String(id)), id: String(id),
      topic: String((n && n.topic) || ''),
      project: String((st && st.project && st.project.name) || '') };
  })()`);
  const o = (r && typeof r === 'object') ? r : { ok: false, text: String(r).slice(0, 160) };
  if (!o.ok) o.text = o.text || ('选中没生效：' + JSON.stringify(o.id));
  return o;
}

/** **真键盘 F2** 开编辑框（`renderer/editor.js` 的 onKey → editSelected → openEditDialog）。
 *  ⚠️ 不是 `style.display='flex'`：判据要的是"产品自己的入口能不能把人带到能输入的状态"。 */
async function openEditByF2(ctx) {
  await ctx.input.pressKey('F2');
  await WAIT.frames(ctx);
  const r = await ctx.exec(`(function () {
    var d = document.getElementById('edit-dialog');
    var t = document.getElementById('edit-dialog-title');
    return { open: !!(d && d.style.display === 'flex'), title: t ? t.textContent : '' };
  })()`);
  return (r && typeof r === 'object') ? r : { open: false, title: '' };
}

/** 某个按钮的**真点坐标** + 命中测试（命中它自己才干真点，否则调用方退回 `.click()`
 *  并在报文里如实说"没点中"）。 */
async function editButtonPoint(ctx, id) {
  const r = await ctx.exec(`(function () {
    var b = document.getElementById(${JSON.stringify(id)});
    if (!b) return { hit: false, why: '没有 #' + ${JSON.stringify(id)} };
    var q = b.getBoundingClientRect();
    var x = Math.round(q.left + q.width / 2), y = Math.round(q.top + q.height / 2);
    var at = document.elementFromPoint(x, y);
    return { x: x, y: y, hit: !!(at && (at === b || (at.closest && at.closest('button') === b))),
      why: at ? (at.tagName + (at.id ? '#' + at.id : '')) : 'null' };
  })()`);
  return (r && typeof r === 'object') ? r : { hit: false, why: String(r).slice(0, 80) };
}

/** 关掉编辑框：优先真鼠标点「取消」（走产品自己的 closeEditDialog），点不中才退回 `.click()`。
 *  收不干净会让**下一个域**被框架判"残留模态"并点名本域 ⇒ 每条断言都 finally 调它。 */
async function closeEditReal(ctx) {
  try {
    const d = await ctx.exec('(function () { var d = document.getElementById("edit-dialog");'
      + ' return !!(d && d.style.display === "flex"); })()');
    if (!d) return false;
    const pt = await editButtonPoint(ctx, 'edit-cancel');
    if (ctx.input && pt.hit) { await ctx.input.click(pt); await WAIT.frames(ctx, { delayMs: 60 }); }
    await ctx.exec('(function () { var d = document.getElementById("edit-dialog");'
      + ' if (d && d.style.display === "flex") document.getElementById("edit-cancel").click(); return 1; })()');
    return true;
  } catch (e) { return false; }
}

/** **一次真的 Enter**（三段，缺一段就不是"真按了一下 Enter"）。
 *
 *  ⚠️ 这一段是本批实测出来的：`ctx.input.pressKey('Return')` 只发 `keyDown` + `keyUp`，
 *  于是产品的 keydown 处理器**看得见**这个 Enter，而**文本层什么都不会被插入** ——
 *  Chromium 的编辑管线里，回车产生的字符来自紧随其后的那个 `char` 事件
 *  （`scripts/smoke-input.js` 的文件头就写着「`keyDown` 不会产生字符」）。
 *  第一次跑这条断言时读数正是这个形状：`框还开着=true`（修好了）但 `值 522 → 522`
 *  ⇒ 只发两段的话，"Enter 真的插入了换行"这件事**永远判不出来**（判据自己会空转）。
 *  ⇒ 三段一起发，才是"人按了一下 Enter"。 */
async function pressEnterReal(ctx) {
  await ctx.input.sendList([
    { type: 'keyDown', keyCode: 'Return', modifiers: [] },
    { type: 'char', keyCode: '\r' },
    { type: 'keyUp', keyCode: 'Return', modifiers: [] }
  ], 0);
  return 3;
}

const assertions = [
  {
    name: 'float detail draggable (header drag moves it)',
    run: async (ctx) => {
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app.getState().jm;
          if (!jm) return Promise.resolve(JSON.stringify({ ok: false, reason: 'no jm' }));
          app.closeAllFloatDetail(); app.showDetail(jm.get_node('tcp-handshake'));
          return new Promise(function (res) {
            setTimeout(function () {
              setLock('screen');
              var fd = document.querySelector('.float-detail');
              fd.style.left = '50px'; fd.style.top = '50px';
              var head = fd.querySelector('.fd-head');
              head.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 200, clientY: 200 }));
              document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 260, clientY: 235 }));
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
              var st = app.getFloatDetailState();
              res(JSON.stringify({ from: '50,50', to: st.left + ',' + st.top, ok: st.left === 110 && st.top === 85 }));
            }, 60);
          });
          function setLock(mode) {
            var boxEl = document.querySelector('.float-detail'); var btn = boxEl.querySelector(mode === 'map' ? '.fd-lock-map' : '.fd-lock-screen');
            for (var i = 0; i < 3; i++) {
              if (window.MMApp.getFloatDetailState().lock === mode) break;
              btn.click();
            }
          }
        })()`
      );
      let ok = false, detail = chk;
      try { ok = JSON.parse(chk).ok; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    name: '小锁 keeps detail at fixed offset from its node (pan)',
    run: async (ctx) => {
      // 需求：小锁 = 详情框相对导图锁死。判据：平移时详情框与**所属节点框**同步位移
      //      （相对位置不变）—— 即"节点框在 (0,0)、详情也锁在那，就一直在那"。
      // 注意：必须先把 scrollTop 归零再设目标值，否则会撞上滚动上界 → 变成"假平移"。
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app.getState().jm;
          if (!jm) return Promise.resolve(JSON.stringify({ ok: false, reason: 'no jm' }));
          app.closeAllFloatDetail();
          jm.expand_to_depth(20);
          window.MM.setViewScale(1);
          app.showDetail(jm.get_node('tcp-handshake'));
          return new Promise(function (res) {
            setTimeout(function () {
              document.querySelector('.float-detail').querySelector('.fd-lock-map').click();
              var panel = document.querySelector('jmnodes').parentElement;
              var node = document.querySelector('jmnode[nodeid="tcp-handshake"]');
              var box = document.querySelector('.float-detail');
              setTimeout(function () {
                var n0 = node.getBoundingClientRect(), b0 = box.getBoundingClientRect();
                var pr = panel.getBoundingClientRect();
                var cx = pr.left + pr.width / 2, cy = pr.top + pr.height / 2, DY = -300;
                panel.dispatchEvent(new MouseEvent('mousedown', { button: 1, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
                document.dispatchEvent(new MouseEvent('mousemove', { button: 1, clientX: cx, clientY: cy + DY, bubbles: true, cancelable: true }));
                document.dispatchEvent(new MouseEvent('mouseup', { button: 1, bubbles: true, cancelable: true }));
                setTimeout(function () {
                  app.positionFloatDetail(); // 显式驱动一次定位
                  var n1 = node.getBoundingClientRect(), b1 = box.getBoundingClientRect();
                  var dNode = Math.round(n1.top - n0.top), dBox = Math.round(b1.top - b0.top);
                  res(JSON.stringify({
                    panDy: DY, nodeDelta: dNode, boxDelta: dBox,
                    lock: app.getFloatDetailState().lock,
                    ok: Math.abs(dNode - dBox) <= 3 && Math.abs(dNode - DY) <= 3
                  }));
                }, 120);
              }, 80);
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
    name: '小锁 keeps detail glued to its node across zoom (offset invariant)',
    run: async (ctx) => {
      // 需求：小锁 = 详情框相对**所属节点框**的位置被锁死。
      // 判据：以「节点框左上角」为原点，详情框偏移量（换算成节点自身坐标，即除以缩放）
      //      在缩放前后必须不变 —— 这就是"节点框在 (0,0)、详情也锁在那，就一直在那"。
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
              box.querySelector('.fd-lock-map').click();
              var node = document.querySelector('jmnode[nodeid="tcp-handshake"]');
              function off() {
                var b = box.getBoundingClientRect(), n = node.getBoundingClientRect();
                var S = jm.view.zoom_current || 1;
                return { x: (b.left - n.left) / S, y: (b.top - n.top) / S };
              }
              var o0 = off();
              window.MM.setViewScale(1.5);
              app.positionFloatDetail();
              setTimeout(function () {
                var o1 = off();
                window.MM.setViewScale(1);
                app.positionFloatDetail();
                res(JSON.stringify({
                  lock: app.getFloatDetailState().lock,
                  offsetZoom1: Math.round(o0.x) + ',' + Math.round(o0.y),
                  offsetZoom1p5: Math.round(o1.x) + ',' + Math.round(o1.y),
                  drift: Math.round(o1.x - o0.x) + ',' + Math.round(o1.y - o0.y),
                  ok: Math.abs(o1.x - o0.x) <= 1.5 && Math.abs(o1.y - o0.y) <= 1.5
                }));
              }, 250);
            }, 250);
          });
        })()`
      );
      let ok = false, detail = chk;
      try { ok = JSON.parse(chk).ok; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    name: 'float detail lock-screen: ignores mindmap pan',
    run: async (ctx) => {
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app.getState().jm;
          if (!jm) return Promise.resolve(JSON.stringify({ ok: false, reason: 'no jm' }));
          app.closeAllFloatDetail();
          jm.expand_to_depth(20);
          window.MM.setViewScale(1);
          app.showDetail(jm.get_node('tcp-handshake'));
          return new Promise(function (res) {
            setTimeout(function () {
              document.querySelector('.float-detail').querySelector('.fd-lock-screen').click();
              var panel = document.querySelector('jmnodes').parentElement;
              var node = document.querySelector('jmnode[nodeid="tcp-handshake"]');
              var box = document.querySelector('.float-detail');
              setTimeout(function () {
                var n0 = node.getBoundingClientRect(), b0 = box.getBoundingClientRect();
                var pr = panel.getBoundingClientRect();
                var cx = pr.left + pr.width / 2, cy = pr.top + pr.height / 2, DY = -300;
                panel.dispatchEvent(new MouseEvent('mousedown', { button: 1, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
                document.dispatchEvent(new MouseEvent('mousemove', { button: 1, clientX: cx, clientY: cy + DY, bubbles: true, cancelable: true }));
                document.dispatchEvent(new MouseEvent('mouseup', { button: 1, bubbles: true, cancelable: true }));
                setTimeout(function () {
                  var n1 = node.getBoundingClientRect(), b1 = box.getBoundingClientRect();
                  var dNode = Math.round(n1.top - n0.top), dBox = Math.round(b1.top - b0.top);
                  // 契约：导图确实平移了（节点位移 ≈ DY），但大锁框纹丝不动（位移 = 0）
                  res(JSON.stringify({
                    panDy: DY, nodeDelta: dNode, boxDelta: dBox,
                    lock: app.getFloatDetailState().lock,
                    ok: Math.abs(dNode - DY) <= 3 && dBox === 0 && app.getFloatDetailState().lock === 'screen'
                  }));
                }, 120);
              }, 80);
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
    name: 'locked detail boxes accumulate (multi-box coexist)',
    run: async (ctx) => {
      // 需求2：未锁定的框被复用；已上锁（小锁/屏幕锁）的框保留不被覆盖 → 可同时展示多个详情框，
      //        且每个新框出现在「节点框的下面」。
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app.getState().jm;
          if (!jm) return Promise.resolve(JSON.stringify({ ok: false, reason: 'no jm' }));
          app.closeAllFloatDetail();
          app.showDetail(jm.get_node('tcp-handshake'));
          return new Promise(function (res) {
            setTimeout(function () {
              document.querySelector('.float-detail').querySelector('.fd-lock-map').click(); // 给第 1 个框上小锁
              app.showDetail(jm.get_node('dns'));                                            // 应另开第 2 个框
              setTimeout(function () {
                var els = document.querySelectorAll('.float-detail');
                var st = app.getFloatDetailState();
                var titles = [];
                for (var i = 0; i < els.length; i++) titles.push(els[i].querySelector('.fd-title').textContent);
                var box2 = els[els.length - 1];
                var n2 = document.querySelector('jmnode[nodeid="dns"]');
                var fr = box2.getBoundingClientRect(), nr = n2.getBoundingClientRect();
                res(JSON.stringify({
                  boxes: st.boxes, locks: st.locks, titles: titles.join(' | '),
                  newBoxBelowNode: fr.top >= nr.bottom - 1,
                  ok: st.boxes === 2 && st.locks[0] === 'map' && st.locks[1] === 'follow'
                    && titles[0].indexOf('TCP 连接管理') >= 0 && titles[1].indexOf('DNS') >= 0
                    && fr.top >= nr.bottom - 1
                }));
              }, 200);
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
    name: 'dragging a detail box auto-applies 小锁 (map lock)',
    run: async (ctx) => {
      // 需求3：一旦被拖动，就自动上小锁（基于其在导图中的位置锁定）
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app.getState().jm;
          if (!jm) return Promise.resolve(JSON.stringify({ ok: false, reason: 'no jm' }));
          app.closeAllFloatDetail();
          app.showDetail(jm.get_node('tcp-handshake'));
          return new Promise(function (res) {
            setTimeout(function () {
              var before = app.getFloatDetailState();
              var fd = document.querySelector('.float-detail');
              fd.style.left = '60px'; fd.style.top = '60px';
              var head = fd.querySelector('.fd-head');
              head.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 200, clientY: 200 }));
              document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 250, clientY: 240 }));
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
              var after = app.getFloatDetailState();
              res(JSON.stringify({
                lockBefore: before.lock, lockAfter: after.lock, left: after.left, top: after.top,
                ok: before.lock === 'follow' && after.lock === 'map'
                  && Math.abs(after.left - 110) <= 1 && Math.abs(after.top - 100) <= 1
              }));
            }, 120);
          });
        })()`
      );
      let ok = false, detail = chk;
      try { ok = JSON.parse(chk).ok; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    name: 'detail box scales with mindmap zoom (fixed ratio to node box)',
    run: async (ctx) => {
      // 需求1：详情框尺寸与节点框保持固定比例 —— 随导图缩放同步缩放（transform: scale(zoom)）
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app.getState().jm;
          if (!jm) return Promise.resolve(JSON.stringify({ ok: false, reason: 'no jm' }));
          app.closeAllFloatDetail();
          window.MM.setViewScale(1);
          app.showDetail(jm.get_node('tcp-handshake'));
          return new Promise(function (res) {
            setTimeout(function () {
              var fd = document.querySelector('.float-detail');
              var w1 = fd.getBoundingClientRect().width;
              var t1 = fd.style.transform || '(none)';
              window.MM.setViewScale(1.5);
              app.positionFloatDetail();
              setTimeout(function () {
                var w15 = fd.getBoundingClientRect().width;
                var t15 = fd.style.transform || '(none)';
                window.MM.setViewScale(1);
                app.positionFloatDetail();
                res(JSON.stringify({
                  widthZoom1: Math.round(w1), widthZoom1p5: Math.round(w15),
                  ratio: Math.round(w15 / w1 * 100) / 100, transform: t1 + ' -> ' + t15,
                  ok: w1 > 0 && Math.abs(w15 / w1 - 1.5) <= 0.05
                }));
              }, 200);
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
    name: 'detail image hover shows 双击浏览 tip near cursor',
    run: async (ctx) => {
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app.getState().jm;
          if (!jm) return Promise.resolve(JSON.stringify({ ok: false, reason: 'no jm' }));
          app.closeAllFloatDetail(); app.showDetail(jm.get_node('tcp-handshake'));
          return new Promise(function (res) {
            setTimeout(function () {
              var img = document.querySelector('.float-detail .fd-images-content img[data-full]');
              if (!img) return res(JSON.stringify({ ok: false, reason: 'no image in detail' }));
              img.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: true, clientX: 400, clientY: 300 }));
              img.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 420, clientY: 340 }));
              var tip = document.getElementById('fd-img-tip');
              var shown = tip.style.display === 'block';
              var text = tip.textContent;
              var left = parseFloat(tip.style.left), top = parseFloat(tip.style.top);
              img.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, cancelable: true }));
              var hiddenAfterLeave = document.getElementById('fd-img-tip').style.display === 'none';
              res(JSON.stringify({
                shown: shown, text: text, left: left, top: top, hiddenAfterLeave: hiddenAfterLeave,
                ok: shown && text === '双击浏览' && left === 434 && top === 356 && hiddenAfterLeave
              }));
            }, 60);
          });
        })()`
      );
      let ok = false, detail = chk;
      try { ok = JSON.parse(chk).ok; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    name: 'detail renders images above 相关知识点区',
    run: async (ctx) => {
      const chk = await ctx.exec(
        `(function () {
          var imgs = document.querySelector('.float-detail .fd-images-content');
          var bl = document.querySelector('.float-detail .fd-related');
          if (!imgs || !bl) return JSON.stringify({ ok: false, reason: 'missing sections' });
          var pos = imgs.compareDocumentPosition(bl);
          return JSON.stringify({
            imagesBeforeBacklinks: !!(pos & 4),
            ok: !!(pos & 4)
          });
        })()`
      );
      let ok = false, detail = chk;
      try { ok = JSON.parse(chk).ok; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    // 锁住一次**删除**（防止被误加回来）：图片区曾同时列出节点声明的 links，
    // 渲染成「🔗 跳转到 <项目>/<id>」并一律调 switchProject()。但 switchProject 开头是
    // `name === state.project.name → return`，于是**同项目链接点了毫无反应** ——
    // 实测 comnet 的 47 条链接全是本项目内，即 47 个死链接。
    // 关系展示现已完全交给「相关知识点」（区分同项目/跨项目、带方向与标题）。
    name: '图片区只放图片：不再出现「🔗 跳转到」这类死链接行',
    run: async (ctx) => {
      const chk = await ctx.exec(
        `(function () {
           var app = window.MMApp;
           var jm = app.getState().jm;
           // 选一个有 links 的节点（comnet 的 overview 声明了多条本项目内链接）
           var id = null;
           var all = jm.mind.nodes ? Object.keys(jm.mind.nodes) : [];
           for (var i = 0; i < all.length; i++) {
             var n = jm.get_node(all[i]);
             if (n && n.data && (n.data.links || []).length) { id = all[i]; break; }
           }
           if (!id) return JSON.stringify({ ok: true, text: '本项目无带 links 的节点（跳过）' });
           app.showDetail(jm.get_node(id));
           var ic = document.querySelector('.float-detail .fd-images-content');
           if (!ic) return JSON.stringify({ ok: false, text: 'no images section' });
           var dead = ic.querySelectorAll('a[data-link-project]').length;
           var jump = ic.innerHTML.indexOf('跳转到') >= 0;
           return JSON.stringify({
             ok: dead === 0 && !jump,
             text: '节点=' + id + ' 死链接数=' + dead + ' 含「跳转到」字样=' + jump,
             __node: id
           });
         })()`
      );
      let ok = false, detail = chk;
      try { const o = JSON.parse(chk); ok = o.ok; detail = o.text; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    // 与「点相关知识点条目」同一根因的第二个表现：`.img-remove` 的处理函数里会
    // renderFdBox() 重建 innerHTML → 被点的按钮当场脱离 DOM → 事件冒泡到容器时
    // `e.target.closest('.float-detail')` 返回 null → 被误判为"点了空白" → 关掉整个详情框。
    // 即"点移除该图，图没了、框也没了"。修复用 composedPath() 取派发当时的路径。
    name: '详情框：点「移除该图」不会把整个详情框一起关掉',
    run: async (ctx) => {
      const chk = await ctx.exec(
        `(function () {
           var app = window.MMApp;
           var jm = app.getState().jm;
           // 找一个带图片的节点
           var all = jm.mind.nodes ? Object.keys(jm.mind.nodes) : [];
           var id = null;
           for (var i = 0; i < all.length; i++) {
             var n = jm.get_node(all[i]);
             if (n && n.data && (n.data.images || []).length) { id = all[i]; break; }
           }
           if (!id) return JSON.stringify({ ok: true, text: '本项目无带图片节点（跳过）' });
           app.showDetail(jm.get_node(id));
           var before = app.getFloatDetailState();
           if (!before.visible) return JSON.stringify({ ok: false, text: '详情框未打开' });
           var btn = document.querySelector('.float-detail .fd-images-content .img-remove');
           if (!btn) return JSON.stringify({ ok: false, text: '未找到移除按钮' });
           btn.click();
           var after = app.getFloatDetailState();
           var boxes = after.boxes || 0;
           var anyVisible = false;
           for (var k = 0; k < boxes; k++) { if (app.getFloatDetailState(k).visible) anyVisible = true; }
           return JSON.stringify({
             ok: boxes > 0 && anyVisible,
             text: '节点=' + id + ' 点击前可见=' + before.visible
                 + ' 点击后框数=' + boxes + ' 仍有可见框=' + anyVisible
           });
         })()`
      );
      let ok = false, detail = chk;
      try { const o = JSON.parse(chk); ok = o.ok; detail = o.text; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },

  /* ==========================================================================================
   * 「编辑节点详情」**真的能输入**（2026-10-26 批 · 用户原话「编辑节点详情功能有问题，不能输入，
   * 你的测试形同虚设」）
   * ------------------------------------------------------------------------------------------
   * ## 治的病根
   *   域 56 过去用 `document.getElementById('edit-detail').value = X` 设值、再读回来比。
   *   那种写法**整条绕过** Chromium 的输入管线（命中测试 / 焦点 / 键盘 / IME）⇒
   *   那个格子就算 `readOnly`、被别的层盖住、在屏幕外、`input` 事件根本没接，**断言照样绿**。
   *   ⇒ 本节判据一律走 `ctx.input`（`webContents.sendInputEvent`，真鼠标 / 真键盘）。
   *
   * ## 三条各自独立（**不许合并**）
   *   甲 几何/命中：格子整块在**可用区**里（`窗口宽 − --dsh-sidebar-width`）、居中都对、
   *      `document.elementFromPoint(格子中心)` 命中的**就是那个 textarea 自己**；
   *   乙 真输入：真点进格子 → 真键盘逐字 ⇒ `.value` 真的变了、`activeElement` 是它；
   *      再点「保存」⇒ **内存里** `node.data.detail` 真的变了；
   *   丙 落盘：真输入 → 点「保存」→ 点工具栏「💾 保存」⇒ **CLI 从盘上读回来的 detail** 里有那串字。
   *   ⇒ 三种注入（格子设成 `readOnly` / 弹窗滑到侧栏底下 / 「保存」改成不读那个格子）
   *      **各自红一条**，不会互相掩护。判别力证明的逐字节还原记录见
   *      `.review/20261045-编辑详情不能输入/`。
   *
   * ## ⚠️ 为什么**不用** `elementFromPoint` 判"没被原生侧栏盖住"
   *   它做不到。侧栏是主进程的 `WebContentsView`，合成在页面**之上**，渲染层的命中测试
   *   **完全看不见它**（本批实测：侧栏区域里 `elementFromPoint` 照样返回页面元素 ✓）。
   *   所以"会不会滑到侧栏底下"的**可判形式**是"矩形右缘 ≤ 可用区宽 + 居中"，不是命中测试。
   *   报文里仍然把 `elementFromPoint` 的读数打出来（中心点 / 可用区右缘 / 窗口右缘），
   *   那是给人看的三处取证，不是判据。
   *
   * ## 为什么三条都"自建前置"
   *   单独跑 `SMOKE_ONLY=04` 时前面的域没跑 ⇒ 项目没开。三条各自先确保项目开着
   *   （只打开、内容由 CLI 读真实沙箱副本），于是都能单独跑、也不靠上位域的残留状态。
   * ========================================================================================== */

  {
    name: '编辑节点对话框的「详情」格：整块落在**可用区**内、居中于可用区，且中心点命中它自己'
      + '（真键盘 F2 开框；报 rect / elementFromPoint / --dsh-sidebar-width 三处读数）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: 'ctx.input 不可用（真输入底座没起来 ⇒ 本项采不到真值，判红）' };
      let closeIt = true;
      try {
        const pre = await ensureProjectOpen(ctx);
        if (!pre.ok) return { ok: false, text: '打开项目失败：' + pre.text };
        const node = await pickNodeForEdit(ctx);
        if (!node.ok) return { ok: false, text: node.text };
        const opened = await openEditByF2(ctx);
        if (!opened.open) {
          return { ok: false, text: '真键盘 F2 没能打开「编辑节点」框（选中=' + JSON.stringify(node.id)
            + ' 标题=' + JSON.stringify(opened.title) + '）—— 入口本身坏了，下面的判据无从谈起' };
        }
        // ── 侧栏展开那一档：与 dsh-sidebar:layout 写的是**同两样东西**（body class + CSS 变量）──
        await ctx.exec('(function () { document.body.classList.add("dsh-sidebar-on");'
          + ' document.body.style.setProperty("--dsh-sidebar-width", "420px"); return 1; })()');
        const g = await ctx.exec(EDIT_GEO_JS);
        await ctx.exec('(function () { document.body.classList.remove("dsh-sidebar-on");'
          + ' document.body.style.removeProperty("--dsh-sidebar-width"); return 1; })()');
        closeIt = false;
        await closeEditReal(ctx);
        if (!g || g.ok !== true) return { ok: false, text: '读不到几何：' + JSON.stringify(g).slice(0, 200) };
        const sideOk = Math.round(g.side) === 420;
        const hasArea = g.ta.width > 0 && g.ta.height > 0;
        const gapL = Math.round(g.box.left);
        const gapR = Math.round(g.avail - g.box.right);
        const centered = Math.abs(gapL - gapR) <= 3;
        const inside = g.box.right <= g.avail + 1;
        return {
          ok: sideOk && hasArea && g.inWindow && inside && centered && g.atIsTa,
          text: '视口 ' + g.vw + '×' + g.vh + ' · --dsh-sidebar-width=' + JSON.stringify(g.sideRaw)
            + ' ⇒ 可用区 ' + g.avail + 'px（期望 420 ⇒ ' + sideOk + '）'
            + ' ｜ #edit-detail rect=' + fmtRect(g.ta) + '（有面积=' + hasArea + '，整块在窗口内=' + g.inWindow + '）'
            + ' ｜ 对话框左右留白 ' + gapL + '/' + gapR + '（居中=' + centered + '）'
            + ' ｜ 右缘 ' + Math.round(g.box.right) + ' ≤ 可用区 ' + g.avail + ' ⇒ ' + inside
            + ' ｜ 格子中心 ' + JSON.stringify(g.center) + ' 命中=' + g.at + '（是格子自己=' + g.atIsTa + '）'
            + ' ｜ 取证（非判据）：可用区右缘-2 → ' + g.edgeAt + '，窗口右缘-2 → ' + g.farAt
            + ' ｜ readOnly=' + g.readOnly + ' disabled=' + g.disabled
        };
      } finally {
        if (closeIt) await closeEditReal(ctx);
      }
    }
  },

  {
    name: '编辑节点对话框的「详情」格**真的能输入**：真鼠标点进格子 + 真键盘逐字 ⇒ .value 变、焦点在格子上；'
      + '点「保存」⇒ **内存里** node.data.detail 真的变了（不是设 value 再读 value）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: 'ctx.input 不可用（真输入底座没起来 ⇒ 本项采不到真值，判红）' };
      try {
        const pre = await ensureProjectOpen(ctx);
        if (!pre.ok) return { ok: false, text: '打开项目失败：' + pre.text };
        const node = await pickNodeForEdit(ctx);
        if (!node.ok) return { ok: false, text: node.text };
        const opened = await openEditByF2(ctx);
        if (!opened.open) return { ok: false, text: '真键盘 F2 没能打开「编辑节点」框' };
        const g = await ctx.exec(EDIT_GEO_JS);
        if (!g || g.ok !== true) return { ok: false, text: '读不到格子几何：' + JSON.stringify(g).slice(0, 200) };
        const before = g.value;
        // ── 真鼠标点进格子（走 Chromium 命中测试）──
        await ctx.input.click(g.center);
        await WAIT.frames(ctx);
        const focused = await ctx.exec(READ_EDIT_STATE_JS);
        // ── 真键盘逐字（`type:'char'` 才会进输入框；keyDown 不产生字符）──
        await ctx.input.typeText(TOKEN_INPUT);
        await WAIT.frames(ctx, { delayMs: 120 });
        const typed = await ctx.exec(READ_EDIT_STATE_JS);
        // ── 点「保存」（真鼠标）⇒ 内存里应当变了 ──
        const okPt = await editButtonPoint(ctx, 'edit-ok');
        let clickOk = false;
        if (okPt.hit) { await ctx.input.click(okPt); await WAIT.frames(ctx); clickOk = true; }
        else await ctx.exec('document.getElementById("edit-ok").click()');
        const after = await ctx.exec(`(function () {
          var jm = window.MMApp.getState().jm;
          var n = jm ? jm.get_node(${JSON.stringify(node.id)}) : null;
          var d = document.getElementById('edit-dialog');
          return { detail: String((n && n.data && n.data.detail) || ''), closed: !!d && d.style.display !== 'flex',
            active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : 'none' };
        })()`);
        const focusOk = focused.active === 'edit-detail';
        const valueChanged = typed.value !== before;
        const hasToken = typed.value.indexOf(TOKEN_INPUT) >= 0;
        const memOk = String(after.detail).indexOf(TOKEN_INPUT) >= 0;
        return {
          ok: focusOk && valueChanged && hasToken && memOk && after.closed,
          text: '真点中心 ' + JSON.stringify(g.center) + ' ⇒ 焦点=' + focused.active + '（期望 edit-detail ⇒ ' + focusOk + '）'
            + ' ｜ 真键盘逐字 ' + JSON.stringify(TOKEN_INPUT) + '（' + TOKEN_INPUT.length + ' 个 char 事件）'
            + ' ⇒ .value ' + before.length + ' 字 → ' + typed.value.length + ' 字，'
            + '变了=' + valueChanged + '、含那串字=' + hasToken
            + ' ｜ 点「保存」真点中=' + clickOk + ' ⇒ 内存 detail 含那串字=' + memOk
            + '（' + String(after.detail).length + ' 字）、框已关=' + after.closed
            + '（原正文 ' + JSON.stringify(before.slice(0, 24)) + '…）'
        };
      } finally {
        await closeEditReal(ctx);
      }
    }
  },

  {
    name: '编辑节点「详情」改完**真的落到盘上**：真输入 → 点「保存」→ 点工具栏「💾 保存」⇒ '
      + 'CLI 从盘上读回来的 detail 里有那串字（内存说成功不算数）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: 'ctx.input 不可用（真输入底座没起来 ⇒ 本项采不到真值，判红）' };
      try {
        const pre = await ensureProjectOpen(ctx);
        if (!pre.ok) return { ok: false, text: '打开项目失败：' + pre.text };
        const node = await pickNodeForEdit(ctx);
        if (!node.ok) return { ok: false, text: node.text };
        const proj = node.project;
        const opened = await openEditByF2(ctx);
        if (!opened.open) return { ok: false, text: '真键盘 F2 没能打开「编辑节点」框' };
        const g = await ctx.exec(EDIT_GEO_JS);
        if (!g || g.ok !== true) return { ok: false, text: '读不到格子几何：' + JSON.stringify(g).slice(0, 200) };
        await ctx.input.click(g.center);
        await WAIT.frames(ctx);
        await ctx.input.typeText(TOKEN_DISK);
        await WAIT.frames(ctx, { delayMs: 120 });
        const typed = await ctx.exec(READ_EDIT_STATE_JS);
        const okPt = await editButtonPoint(ctx, 'edit-ok');
        if (okPt.hit) await ctx.input.click(okPt); else await ctx.exec('document.getElementById("edit-ok").click()');
        await WAIT.frames(ctx);
        // ── 工具栏「💾 保存」（真鼠标）：这一步才是落盘 ──
        const savePt = await editButtonPoint(ctx, 'btn-save');
        let saveHit = false;
        if (savePt.hit) { await ctx.input.click(savePt); saveHit = true; } else await ctx.exec('document.getElementById("btn-save").click()');
        // ── 盘上真值：**CLI 读沙箱副本**（不读页面自报）──
        let diskDetail = null, cliErr = '';
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 150));
          try {
            const flat = JSON.parse(ctx.runCli(['read', proj, '--json', '--subtree', String(node.id)]));
            const nodes = Array.isArray(flat.nodes) ? flat.nodes : [];
            const hit = nodes.filter((n) => String(n.id) === String(node.id))[0];
            if (hit) diskDetail = String(hit.detail || '');
            if (diskDetail !== null && diskDetail.indexOf(TOKEN_DISK) >= 0) break;
          } catch (e) { cliErr = String((e && e.message) || e).slice(0, 120); }
        }
        const diskOk = diskDetail !== null && diskDetail.indexOf(TOKEN_DISK) >= 0;
        const status = await ctx.exec('(function () { var s = document.getElementById("status-text"); return s ? s.textContent : ""; })()');
        return {
          ok: typed.value.indexOf(TOKEN_DISK) >= 0 && diskOk,
          text: '真输入 ' + JSON.stringify(TOKEN_DISK) + ' ⇒ .value 含那串字='
            + (typed.value.indexOf(TOKEN_DISK) >= 0)
            + ' ｜ 点「保存」+ 点「💾 保存」（真点中=' + saveHit + '）'
            + ' ⇒ **盘上** detail 含那串字=' + diskOk
            + '（CLI 读 ' + proj + '/' + node.id + '：' + (diskDetail === null ? '读不到 ' + cliErr : String(diskDetail).length + ' 字') + '）'
            + ' ｜ 状态栏=' + JSON.stringify(String(status).slice(0, 40))
        };
      } finally {
        await closeEditReal(ctx);
      }
    }
  },

  /* ------------------------------------------------------------------------------------------
   * 丁（**2026-10-26 复现出来的真缺陷**）：正文格里的 **Enter 必须是换行，不是"提交并关框"**
   * ------------------------------------------------------------------------------------------
   * 形状（`renderer/editor.js` 的 `onKey`）：只要编辑框开着，任何 `Enter`（不带 Shift）都会走
   * `saveEditDialog()` —— 它对**单行输入**（标题/标签）是便利，对 `#edit-detail` 这个
   * **多行 textarea** 就是"永远打不出换行"：
   *   · 正文本身就是多行的 HTML（`<h3>…</h3>\n<ul>\n<li>…` —— 盘上那份原文就带换行），
   *     人到框里按 Enter 想换行 ⇒ 框**直接关掉并保存**；
   *   · 更狠的一档是**中文输入法**：选中候选词那一下就是 `Enter`（组合期），
   *     `onKey` 没有判 `e.isComposing` ⇒ 每选一个字都可能把框关掉 —— 用户嘴里的"不能输入"。
   * ⇒ 判据（真键盘，不是合成事件）：
   *   ① 点进正文格 → 逐字输入 → 按 Enter ⇒ 框**还开着**，且 `.value` 里**多了换行**、长度 +1；
   *   ② 单行输入（标题格）里按 Enter 仍应保存关框（这是既有语义，别顺手改掉它 ——
   *      所以本条**同时判两个格子**，修法必须"只让多行框不提交"，不能一刀切关掉 Enter 提交）。
   * ⚠️ 域 56 的旧写法（`value = X` 一次性设值）**永远不会按 Enter** ⇒ 这条缺陷在它眼里不存在，
   *    正是用户说的"形同虚设"。
   * ------------------------------------------------------------------------------------------ */
  {
    name: '编辑节点「详情」格里的 Enter 必须是**换行**（且框不关）：真键盘逐字 + Enter 后 '
      + '框仍开着、值里多一个换行；而**标题格**里 Enter 仍照旧提交关框（两个格子都要判）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: 'ctx.input 不可用（真输入底座没起来 ⇒ 本项采不到真值，判红）' };
      try {
        const pre = await ensureProjectOpen(ctx);
        if (!pre.ok) return { ok: false, text: '打开项目失败：' + pre.text };
        const node = await pickNodeForEdit(ctx);
        if (!node.ok) return { ok: false, text: node.text };
        const opened = await openEditByF2(ctx);
        if (!opened.open) return { ok: false, text: '真键盘 F2 没能打开「编辑节点」框' };
        const g = await ctx.exec(EDIT_GEO_JS);
        if (!g || g.ok !== true) return { ok: false, text: '读不到格子几何：' + JSON.stringify(g).slice(0, 200) };
        // ── 甲：正文格里打字 + Enter ──
        await ctx.input.click(g.center);
        await WAIT.frames(ctx);
        await ctx.input.typeText(TOKEN_ENTER);
        await WAIT.frames(ctx, { delayMs: 80 });
        const beforeEnter = await ctx.exec(READ_EDIT_STATE_JS);
        await pressEnterReal(ctx);
        await WAIT.frames(ctx, { delayMs: 150 });
        const afterEnter = await ctx.exec(`(function () {
          var d = document.getElementById('edit-dialog');
          var ta = document.getElementById('edit-detail');
          return { open: !!(d && d.style.display === 'flex'),
            value: ta ? String(ta.value == null ? '' : ta.value) : '',
            active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : 'none' };
        })()`);
        const detailStillOpen = afterEnter.open === true;
        const grown = afterEnter.value.length === beforeEnter.value.length + 1;
        /* 插入的那一段 = **前后差分**（不是"取末尾一个字符"）：光标在正文中间时 —— 本断言就是
         * 点格子**中心**进去的 —— 插入发生在中间，取末尾只会读到原文里最后那个 `>`。
         * 第一版就是这么写错的（读数 `插入段=">" 码点=62`），差别只在"判据自己的取法"。
         * 换行字节 `\n` / `\r` 都算：真人按 Enter 是 `\n`，本驱动的 `{type:'char', keyCode:'\r'}`
         * 可能留 `\r`；判的是"**框没关 + 真的插进了一个换行**"，不是"字节必须是 \n"。 */
        const ins = diffInserted(beforeEnter.value, afterEnter.value);
        const gotNewline = ins === '\n' || ins === '\r' || ins === '\r\n';
        const tailCodes = Array.from(ins).map((c) => c.charCodeAt(0)).join(',');
        // ── 乙：标题格里 Enter 仍要提交关框（既有语义，别顺手改掉）──
        await closeEditReal(ctx);
        const opened2 = await openEditByF2(ctx);
        if (!opened2.open) return { ok: false, text: '第二次 F2 没能打开「编辑节点」框（上一步留下的状态没清干净？）' };
        const topicPt = await ctx.exec(`(function () {
          var t = document.getElementById('edit-topic');
          var r = t.getBoundingClientRect();
          var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
          var at = document.elementFromPoint(x, y);
          return { x: x, y: y, hit: !!(at && (at === t || (at.id || '') === 'edit-topic')) };
        })()`);
        let topicHit = false;
        if (topicPt && topicPt.hit) { await ctx.input.click({ x: topicPt.x, y: topicPt.y }); topicHit = true; }
        await WAIT.frames(ctx);
        await ctx.input.pressKey('Return');
        await WAIT.frames(ctx, { delayMs: 200 });
        const afterTopicEnter = await ctx.exec(`(function () {
          var d = document.getElementById('edit-dialog');
          return { open: !!(d && d.style.display === 'flex') };
        })()`);
        const topicSubmitted = afterTopicEnter.open === false;
        return {
          ok: detailStillOpen && grown && gotNewline && topicSubmitted,
          text: '正文格：真键盘 ' + JSON.stringify(TOKEN_ENTER) + '（' + TOKEN_ENTER.length + ' 个 char）+ Enter ⇒ 框还开着='
            + detailStillOpen + '、值 ' + beforeEnter.value.length + ' → ' + afterEnter.value.length + ' 字'
            + '（+1=' + grown + '、插进去的是换行=' + gotNewline + '，插入段=' + JSON.stringify(ins)
            + ' 码点=' + (tailCodes || '（空）') + '）、焦点=' + afterEnter.active
            + ' ｜ 标题格：真点中=' + topicHit + ' + Enter ⇒ 关框=' + topicSubmitted
            + '（既有语义，必须保持 true）'
            + (detailStillOpen ? '' : ' ｜ ✗ 正文格里按 Enter 把整个编辑框关掉了 ⇒ 多行正文打不出换行，'
              + '中文输入法选词那一下（组合期的 Enter）也会把框关掉 = 用户说的「不能输入」')
        };
      } finally {
        await closeEditReal(ctx);
      }
    }
  },

  /* ==========================================================================================
   * 【2026-10-27 UI 优化】「保存」按钮必须**始终在视口 / 对话框可见区内**
   * ------------------------------------------------------------------------------------------
   * ## 治的病
   *   `.dialog-box` 是 `max-height:85vh; overflow-y:auto`，而 `.dialog-actions` 是它的**最后一个
   *   子元素** ⇒ 内容一高（草稿窗实测视口只有 805×251），动作行就被滚出视口，用户得先自己往下滚
   *   才点得到「保存」。草稿窗那边靠 `editor.js` 的 `scrollIntoView` 兜着，主窗连兜都没有。
   *
   * ## 修法
   *   动作行 `position: sticky; bottom: 0`（纯 CSS，不改 DOM 骨架）⇒ 滚动到任何位置，它都贴在
   *   对话框可见区的底部。同一处口径在 `style.css` 的 `.dialog-actions` 与 `draft-map.html` 的
   *   `.mm-ed-actions` 上各一份（两个页面各一张表）。
   *
   * ## 判据为什么"自己把内容撑高"
   *   主窗 1424×900 时编辑框**本来就不溢出**（sticky 在这里插不上手 ⇒ 断言恒绿 = 空转）。
   *   所以先把 `#edit-detail` 撑到 1200px 人为制造溢出（读的是**产品自己的样式**，不是伪造 DOM），
   *   然后在 **scrollTop=0** 与 **scrollTop=max** 两个位置各量一次：
   *     ① 「保存」矩形整块落在对话框**可见区**内；② 整块落在**视口**内。
   *   没有 sticky 时，scrollTop=0 那一次读到的是 y≈1200（视口外）⇒ 必红。
   * ========================================================================================== */
  {
    name: '编辑对话框的「保存」始终在可见区内：把正文撑高制造溢出后，滚到顶 / 滚到底都不许出框'
      + '（粘底动作行；纯 CSS，不靠 scrollIntoView）',
    run: async (ctx) => {
      let stretched = false;
      try {
        const pre = await ensureProjectOpen(ctx);
        if (!pre.ok) return { ok: false, text: '打开项目失败：' + pre.text };
        const node = await pickNodeForEdit(ctx);
        if (!node.ok) return { ok: false, text: node.text };
        const opened = await openEditByF2(ctx);
        if (!opened.open) return { ok: false, text: '真键盘 F2 没能打开「编辑节点」框' };
        // 制造溢出：把正文格撑到 1200px（只改**这一个实例的 height**，不改任何产品规则）
        const made = await ctx.exec(`(function () {
          var ta = document.getElementById('edit-detail');
          var box = document.querySelector('#edit-dialog .dialog-box');
          if (!ta || !box) return { ok: false, why: '缺 #edit-detail 或 .dialog-box' };
          ta.style.height = '1200px';
          box.scrollTop = 0;
          return { ok: true, overflow: box.scrollHeight > box.clientHeight + 8,
                   scrollHeight: box.scrollHeight, clientHeight: box.clientHeight };
        })()`);
        stretched = true;
        const measure = `(function () {
          var btn = document.getElementById('edit-ok');
          var box = document.querySelector('#edit-dialog .dialog-box');
          if (!btn || !box) return { ok: false, why: '缺 #edit-ok 或 .dialog-box' };
          var b = btn.getBoundingClientRect(), q = box.getBoundingClientRect();
          var vh = window.innerHeight, vw = window.innerWidth;
          /* 真判据（不是几何）：对按钮**中心**做命中测试 —— 被 sticky 动作行/遮罩/父层裁掉时
           * rect 读数与正常显示**完全一样**，只有 elementFromPoint 与真帧像素能分辨
           * （门禁 V1 visibility-judge-check 就是为此存在的）。 */
          var cx = Math.round(b.left + b.width / 2), cy = Math.round(b.top + b.height / 2);
          var at = document.elementFromPoint(cx, cy);
          var hit = !!(at && (at === btn || (at.closest && at.closest('button') === btn)));
          return { ok: true,
            btn: { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) },
            box: { top: Math.round(q.top), bottom: Math.round(q.bottom) },
            vh: vh, vw: vw, scrollTop: Math.round(box.scrollTop),
            center: { x: cx, y: cy }, at: at ? (at.tagName + (at.id ? '#' + at.id : '')) : 'null', hit: hit,
            inBox: b.top >= q.top - 1 && b.bottom <= q.bottom + 1,
            inView: b.top >= -1 && b.bottom <= vh + 1 && b.left >= -1 && b.right <= vw + 1 };
        })()`;
        const top = await ctx.exec(measure);
        await ctx.exec('(function () { var box = document.querySelector("#edit-dialog .dialog-box");'
          + ' box.scrollTop = box.scrollHeight; return 1; })()');
        const bottom = await ctx.exec(measure);
        const ok = !!(made && made.ok && made.overflow && top && top.ok && bottom && bottom.ok
          && top.inBox && top.inView && top.hit && bottom.inBox && bottom.inView && bottom.hit);
        return {
          ok,
          text: '把正文撑到 1200px ⇒ 对话框溢出=' + (made && made.overflow)
            + '（scrollHeight ' + (made && made.scrollHeight) + ' > clientHeight ' + (made && made.clientHeight) + '）'
            + ' ｜ 滚到顶 scrollTop=' + (top && top.scrollTop) + ' ⇒ 「保存」rect=' + JSON.stringify(top && top.btn)
            + ' 在框内=' + (top && top.inBox) + ' 在视口内=' + (top && top.inView)
            + ' 中心命中自己=' + (top && top.hit) + '（命中=' + (top && top.at) + '）'
            + ' ｜ 滚到底 scrollTop=' + (bottom && bottom.scrollTop) + ' ⇒ rect=' + JSON.stringify(bottom && bottom.btn)
            + ' 在框内=' + (bottom && bottom.inBox) + ' 在视口内=' + (bottom && bottom.inView)
            + ' 中心命中自己=' + (bottom && bottom.hit) + '（命中=' + (bottom && bottom.at) + '）'
            + '（视口 ' + (top && top.vw) + '×' + (top && top.vh) + '）'
        };
      } finally {
        if (stretched) {
          await ctx.exec('(function () { var ta = document.getElementById("edit-detail");'
            + ' if (ta) ta.style.height = ""; return 1; })()');
        }
        await closeEditReal(ctx);
      }
    }
  },

  /* ==========================================================================================
   * 【2026-10-27 UI 优化】可点区台账的**实测**一档（声明台账在 `tests/ui-tokens.test.js`）
   * ------------------------------------------------------------------------------------------
   * 改版前实测：工具栏按钮 **25.6px** 高（font 13×1.2 + padding 4×2 + border 2）、详情框标题栏
   * 微钮 **≈18px** —— `app-screens.md` §9.4 给的控件高区间是 27–40（median 34）。
   * 现在：工具栏/对话框 ≥32（`--hit-min`）、详情框标题栏微钮 ≥28（**登记的唯一例外**：那一行 33px
   * 高是域 40 热度条判据⑪的几何前提，32 放不下）、孤立手势圆钮 ≥44（`--hit-gesture`）。
   * 判据读的是**真实矩形**，不是声明。
   * ========================================================================================== */
  {
    name: '可点区实测：工具栏按钮 ≥32、详情框标题栏微钮 ≥24、重展开圆钮 ≥44（读真实 getBoundingClientRect）',
    run: async (ctx) => {
      try {
        const pre = await ensureProjectOpen(ctx);
        if (!pre.ok) return { ok: false, text: '打开项目失败：' + pre.text };
        const node = await pickNodeForEdit(ctx);
        if (!node.ok) return { ok: false, text: node.text };
        // 开一个详情框（`.fd-head-btns` 只在框里；用产品自己的入口 MM.showDetail）
        const openedBox = await ctx.exec(`(function () {
          var app = window.MMApp, st = app.getState ? app.getState() : null;
          var jm = st && st.jm;
          if (!jm) return { ok: false, why: '没有 jm' };
          var n = jm.get_node(${JSON.stringify(node.id)});
          if (!n) return { ok: false, why: '拿不到节点 ' + ${JSON.stringify(node.id)} };
          try { app.closeAllFloatDetail(); } catch (e) {}
          window.MM.showDetail(n);
          return { ok: true };
        })()`);
        await ctx.exec('new Promise(function (res) { setTimeout(res, 250); })');
        const r = await ctx.exec(`(function () {
          function sizes(sel) {
            var out = [];
            Array.prototype.slice.call(document.querySelectorAll(sel)).forEach(function (el) {
              var q = el.getBoundingClientRect();
              var cs = getComputedStyle(el);
              if (cs.display === 'none' || cs.visibility === 'hidden') return;
              if (!q.width && !q.height) return;
              out.push({ w: Math.round(q.width), h: Math.round(q.height) });
            });
            return out;
          }
          return { tb: sizes('#toolbar button'), fd: sizes('.float-detail .fd-head-btns button'),
                   fab: sizes('#dsh-restore-fab'), dlg: sizes('.dialog-actions button') };
        })()`);
        const minH = (arr) => (arr.length ? Math.min.apply(null, arr.map((x) => x.h)) : null);
        const tb = minH(r.tb), fd = minH(r.fd), fab = minH(r.fab);
        const tbOk = tb !== null && tb >= 32;
        const fdOk = fd !== null && fd >= 24;
        /* 重展开圆钮只在"侧栏折叠"时可见；采不到就**如实报未采到**，不当通过也不当失败
         * （它是另一条独立判据的对象，见域 11；这里只做"采到就查"）。 */
        const fabOk = fab === null ? null : fab >= 44;
        const ok = tbOk && fdOk && (fabOk === null || fabOk);
        return {
          ok,
          text: '开详情框=' + (openedBox && openedBox.ok ? 'ok' : JSON.stringify(openedBox))
            + ' ｜ 工具栏按钮 ' + r.tb.length + ' 个，最矮 ' + tb + 'px（≥32 ⇒ ' + tbOk + '）'
            + ' ｜ 详情框标题栏微钮 ' + r.fd.length + ' 个，最矮 ' + fd + 'px（≥24（登记例外：标题框 33px 是域 40 的硬契约）⇒ ' + fdOk + '）'
            + ' ｜ 重展开圆钮 ' + (r.fab.length ? (fab + 'px（≥44 ⇒ ' + fabOk + '）') : '不可见 ⇒ 本档未采到')
            + ' ｜ 对话框动作按钮 ' + r.dlg.length + ' 个'
        };
      } finally {
        await ctx.exec('(function () { try { if (window.MMApp && MMApp.closeAllFloatDetail) MMApp.closeAllFloatDetail(); } catch (e) {} return 1; })()');
      }
    }
  }
];

module.exports = assertions;
