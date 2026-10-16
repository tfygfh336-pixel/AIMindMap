/* ============================================================
 * scripts/smoke/50-五星评价.js —【R6】五星评价 + 反馈闭环（会话级最小档）
 * ------------------------------------------------------------
 * 覆盖（判据 ①–⑦ + 本批拍板新增两条；全链路、真鼠标、零模型调用、零出网）：
 *   ① 真回答（冒烟桩）后，星标行长在那条回答的动作行里、真鼠标点得动（sendInputEvent
 *      + elementFromPoint 命中星按钮自身）；无回答的空框没有星标（默认档零噪声的一半）。
 *   ② 点星 ⇒ **自动弹框**（elementFromPoint 命中面板）＋ 标题口径"这次会话哪点让您不满意/满意？"
 *      ＋ 选项的 data-signal 全部可指回信号名，且与**页内产品自己的纯函数**现算结果逐项一致
 *      （deriveFeedbackCandidates(collectAnswerSignals(entry,st), stars)）＋ 候选数 ≤ 常量上限。
 *   ③ 落库：星击**即刻**落库；末行 stars/text 与点击一致、键白名单齐全（schema/id/at/stars/
 *      text/target/src —— 任务书口径称"6 键"，实为 7 个键名，如实照名单判）、src/target 正确；
 *      多次点星 ⇒ 多行、id 各不相同（只追加 ✗ 不覆盖；文件前缀逐字节保留）。
 *   ④ ⭐ 下次会话展示：node 侧**直接往库里追加一条渲染层从没见过的行** ⇒ 关框重开会话
 *      ⇒ 摘要条出现且行文本与库内容逐条相等（读文件 ✗ 不吃内存缓存 —— 这同时就是
 *      "把'下次展示'改成读内存 ⇒ 必红"的判别力构造 ✓）。
 *   ⑤ 打分不改数据：打分全程项目 JSON sha256 逐字节不变；反馈文件不在 projects/** 之下。
 *   ⑥ 零网络：本轮问答带 .ask-stub 桩标记（app:ask 冒烟桩），全程零模型调用。
 *   ⑦ 默认档：删掉反馈文件 ⇒ 重开会话摘要条**如实消失**、读取返回 missing:true（不说"0 条" ✗）。
 *   补A（本批拍板）：真实 %APPDATA% 侧的 mm-feedback.jsonl 逐字节不变（--smoke 档没碰真实侧）。
 *   补B（结构）：main.js 的反馈路径推导与 append handler 都不含 projects/**；
 *      渲染层 0 处 localStorage；preload 两条**纯透传**（各恰好一次 ipcRenderer.invoke）。
 *
 * 判别力（"临时改产品代码那一轮"，做法照 40/44/45/49 域；每次都记 SHA-256 并逐字节还原）：
 *   (a) 把 SMOKE_FEEDBACK_FILE 改到沙箱 projects/** 之下 ⇒ 补B 的路径断言必红（这正是红线 ✓）；
 *   (b) 把 loadFeedbackSummary 改成模块级缓存（读内存）⇒ ④ 的"库里新行出现"必红；
 *   (c) 把选项改成固定写死 ⇒ ② 的"可指回信号（与纯函数现算一致）"必红。
 *
 * 数据：运行时从界面自己的树里挑一个可见节点（不写死 id ✗）；反馈库路径来自主进程报给断言的
 *   AI_MINDMAP_FEEDBACK_FILE（冒烟档 = 沙箱根下，随沙箱清理；真实侧只读不改 ✓）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const FEEDBACK_FILE = process.env.AI_MINDMAP_FEEDBACK_FILE || '';   // 冒烟档：主进程报给断言的路径
const PROJECTS_DIR = process.env.AI_MINDMAP_PROJECTS_DIR || '';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REAL_PROJECTS_ROOT = path.join(REPO_ROOT, 'projects');
const REAL_FEEDBACK_FILE = path.join(process.env.APPDATA || '', 'AI MindMap', 'mm-feedback.jsonl');

/** 本域跨断言共享的状态（同一域内顺序执行 ⇒ 状态持久是设计好的，跨域由每域隔离管 ✓） */
const S = {
  projFile: null, projSha0: null,
  fb0: { exists: false, sha: null },     // 沙箱反馈库的开工快照（通常不存在）
  real0: { exists: false, sha: null },   // 真实侧反馈库的开工快照（只读不改）
  pickedText: '',                        // A3 点亮那个选项的 data-text
  q: '域50冒烟提问'
};

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

function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
  catch (e) { return null; }   // null = 不存在/读不动（与"存在但内容不同"可分辨 ✓）
}

/** 读反馈库（node 侧现算）：不存在 ⇒ null；坏行跳过并计数（与渲染层同一口径：如实 ✗ 不静默） */
function readFeedback(p) {
  let t;
  try { t = fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
  const lines = []; let skipped = 0;
  t.split('\n').forEach((ln) => {
    const s = ln.trim();
    if (!s) return;
    try { lines.push(JSON.parse(s)); } catch (e) { skipped++; }
  });
  return { lines: lines, skipped: skipped, raw: t };
}

/** 真鼠标点一个点（照 26/36 域的做法：sendInputEvent 走 Chromium 命中测试 ✗ 不用合成事件） */
function realClick(ctx, pt) {
  ctx.win.webContents.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
  ctx.win.webContents.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  ctx.win.webContents.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
}

/** 挑一个有真实几何的可见节点（照 26 域：不写死 id ✗） */
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

/** 开工前置：等启动安定 → 关掉所有浮层框（含恢复出来的详情框）→ 快照（项目 JSON / 沙箱库 / 真实侧库） */
async function prepare(ctx) {
  await new Promise((r) => setTimeout(r, 1200));
  await ctx.exec(`(function () {
    Array.prototype.slice.call(document.querySelectorAll('.float-detail .fd-close')).forEach(function (b) { b.click(); });
    return 1;
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  const proj = await execJson(ctx, `(function () {
    var p = window.MMApp.getState().project || {};
    return JSON.stringify({ ok: !!(p.name && p.file), name: p.name || '', file: p.file || '' });
  })()`);
  if (proj.ok) {
    S.projFile = proj.file;
    S.projSha0 = sha256File(S.projFile);
  }
  S.fb0 = { exists: fs.existsSync(FEEDBACK_FILE), sha: sha256File(FEEDBACK_FILE) };
  S.real0 = { exists: fs.existsSync(REAL_FEEDBACK_FILE), sha: sha256File(REAL_FEEDBACK_FILE) };
  return proj;
}

/** 把 ask 框摆进**可视区**（等价于用户拖一把）。为什么存在：窄窗 + DSH 侧栏开着时，默认落点
 *  pw*0.52 会越出 #mindmap-container 的 overflow:hidden 裁剪框（实测容器右缘 730 / 框右缘 930）
 *  ⇒ 越出部分真的看不见也点不到 —— 这是**既有**默认落点行为（本批不改它 ✗；域里只做
 *  "用户会做的拖动"等价物，摆不进去 = 响亮红 ✓）。开框与重开后都要调一次。 */
async function placeBoxIntoView(ctx) {
  return execJson(ctx, `(function () {
    var box = document.querySelector('.fd-ask-box');
    var cont = document.getElementById('mindmap-container');
    if (!box || !cont) return JSON.stringify({ ok: false, text: '框或容器不见了' });
    var cr = cont.getBoundingClientRect(), br = box.getBoundingClientRect();
    if (br.right > cr.right - 2) {
      box.style.left = (parseFloat(box.style.left) - Math.round(br.right - (cr.right - 6))) + 'px';
    }
    if (br.bottom > cr.bottom - 2) {
      box.style.top = Math.max(cr.top + 4,
        parseFloat(box.style.top) - Math.round(br.bottom - (cr.bottom - 6))) + 'px';
    }
    var r2 = box.getBoundingClientRect();
    var inside = r2.left >= cr.left + 2 && r2.right <= cr.right - 2
      && r2.top >= cr.top + 2 && r2.bottom <= cr.bottom - 2;
    return JSON.stringify({ ok: inside, text: '容器=' + [cr.left, cr.top, cr.right, cr.bottom].join(',')
      + ' 框现=' + [r2.left, r2.top, r2.right, r2.bottom].join(',') + ' 全在可视区内=' + inside });
  })()`);
}

/** 开一个全新问答框并等到桩回答（每条断言各自开 ⇒ 不依赖上一条留下的状态 ✓） */
async function openBoxWithAnswer(ctx) {
  const pick = await pickVisibleNode(ctx);
  if (!pick.ok) return { ok: false, text: pick.text };
  await ctx.exec(`(function () {
    Array.prototype.slice.call(document.querySelectorAll('.fd-ask-box .fd-close')).forEach(function (b) { b.click(); });
    return 1;
  })()`);
  await new Promise((r) => setTimeout(r, 150));
  await ctx.exec(`window.MM.showAskBox(${JSON.stringify(pick.node.id)}, { kind: 'ask' }); 1`);
  const sent = await execJson(ctx, `(function () {
    var box = document.querySelector('.fd-ask-box');
    if (!box) return JSON.stringify({ ok: false, text: '没有问答浮窗' });
    var input = box.querySelector('.ask-input');
    if (!input) return JSON.stringify({ ok: false, text: '没有输入行' });
    input.value = ${JSON.stringify(S.q)};
    box.querySelector('.ask-send').click();
    return JSON.stringify({ ok: true, text: '已发送' });
  })()`);
  if (!sent.ok) return sent;
  const answered = await waitFor(ctx, `(function () {
    var box = document.querySelector('.fd-ask-box');
    var t = box ? (box.textContent || '') : '';
    return JSON.stringify({ ok: t.indexOf('这是回答占位') >= 0 && !box.querySelector('.ask-pending'),
      text: '等桩回答' });
  })()`);
  const o = JSON.parse(answered);
  if (!o.ok) return { ok: false, text: '桩回答没出来：' + o.text };
  const placed = await placeBoxIntoView(ctx);
  if (!placed.ok) return { ok: false, text: '框摆不进可视区（前置失败）：' + placed.text };
  return { ok: true, text: '节点=' + pick.node.id + ' ｜ ' + placed.text, node: pick.node };
}

/** 真鼠标点第 k 颗星（k 从 1 数）：先 scrollIntoView（框内滚动裁切 ⇒ 星可能在滚动视口外，
 *  实测 (709,625) 命中 .fd-scroll 本体 —— "滚到看得见"正是用户会做的动作 ✓），
 *  再 elementFromPoint 预检，再 sendInputEvent，再等弹框 */
async function realClickStar(ctx, k) {
  const pt = await execJson(ctx, `(function () {
    var box = document.querySelector('.fd-ask-box');
    var stars = box.querySelectorAll('.ask-acts .ask-star');
    var b = stars[${k - 1}];
    if (!b) return JSON.stringify({ ok: false, text: '没有第 ${k} 颗星' });
    b.scrollIntoView({ block: 'center' });
    var r = b.getBoundingClientRect();
    var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    var at = document.elementFromPoint(cx, cy);
    var hit = !!(at && (at === b || (at.closest && at.closest('.ask-star') === b)));
    var diag = '';
    if (!hit) {
      var box = document.querySelector('.fd-ask-box');
      var br = box ? box.getBoundingClientRect() : null;
      var chain = [];
      var e2 = box;
      while (e2 && e2 !== document.documentElement) {
        var c2 = window.getComputedStyle(e2);
        var r2 = e2.getBoundingClientRect();
        chain.push(e2.tagName + (e2.id ? '#' + e2.id : '') + '.' + String(e2.className || '').slice(0, 24)
          + '{vis:' + c2.visibility + ',pe:' + c2.pointerEvents + ',ov:' + c2.overflow
          + ',rect:' + [Math.round(r2.left), Math.round(r2.top), Math.round(r2.right), Math.round(r2.bottom)].join(',') + '}');
        e2 = e2.parentElement;
      }
      diag = ' ｜ 命中栈=' + (document.elementsFromPoint ? document.elementsFromPoint(cx, cy).slice(0, 5)
          .map(function (e3) { return e3.tagName + '.' + String(e3.className || '').slice(0, 40); }).join('>') : 'n/a')
        + ' ｜ box.rect=' + (br ? JSON.stringify({ l: Math.round(br.left), t: Math.round(br.top), r: Math.round(br.right), b: Math.round(br.bottom) }) : 'null')
        + ' ｜ viewport=' + window.innerWidth + 'x' + window.innerHeight
        + ' ｜ 祖先链=' + chain.join(' >> ');
    }
    return JSON.stringify({ ok: hit, x: cx, y: cy, hitSelf: hit,
      text: '星心=(' + cx + ',' + cy + ') elementFromPoint 命中自身=' + hit
        + (hit ? '' : '（命中=' + (at ? at.tagName + '.' + (at.className || '') : 'null') + '）' + diag) });
  })()`);
  if (!pt.ok) return pt;
  realClick(ctx, pt);
  await new Promise((r) => setTimeout(r, 250));
  return pt;
}

module.exports = [
  {
    name: 'R6①+⑦前半：真回答后星标行长出来（5 颗、真鼠标点得动、elementFromPoint 命中自身）；空框没有星标（默认档零噪声）',
    run: async (ctx) => {
      if (!FEEDBACK_FILE) return { ok: false, text: 'AI_MINDMAP_FEEDBACK_FILE 没设（主进程没把冒烟反馈库路径报给断言）' };
      const proj = await prepare(ctx);
      if (!proj.ok) return { ok: false, text: '拿不到项目（name/file）：' + proj.text };
      const pick = await pickVisibleNode(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      // ⑦前半：全新空框 ⇒ 没有星标（星标只在真回答后出现 ✓）
      await ctx.exec(`window.MM.showAskBox(${JSON.stringify(pick.node.id)}, { kind: 'ask' }); 1`);
      await new Promise((r) => setTimeout(r, 200));
      const empty = await execJson(ctx, `(function () {
        var box = document.querySelector('.fd-ask-box');
        return JSON.stringify({ ok: !!box && !box.querySelector('.ask-stars') && !!box.querySelector('.ask-empty'),
          text: '空框：星标数=' + box.querySelectorAll('.ask-stars').length + ' 有"请你先问"=' + !!box.querySelector('.ask-empty') });
      })()`);
      // 关掉空框，重开并真的问一句（桩回答）
      const opened = await openBoxWithAnswer(ctx);
      if (!opened.ok) return { ok: false, text: empty.text + ' ｜ ' + opened.text };
      const stars = await execJson(ctx, `(function () {
        var box = document.querySelector('.fd-ask-box');
        var rows = box.querySelectorAll('.ask-acts');
        var spans = box.querySelectorAll('.ask-acts .ask-stars');
        var btns = box.querySelectorAll('.ask-acts .ask-star');
        var stub = !!box.querySelector('.ask-stub');
        var b4 = btns[3];
        var r = b4 ? b4.getBoundingClientRect() : null;
        var at = r ? document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)) : null;
        var hit = !!(at && (at === b4 || (at.closest && at.closest('.ask-star') === b4)));
        return JSON.stringify({ ok: rows.length === 1 && spans.length === 1 && btns.length === 5 && stub && hit,
          text: '动作行=' + rows.length + ' 星标组=' + spans.length + ' 星按钮=' + btns.length
            + ' 桩标记=' + stub + ' 第4颗星 elementFromPoint 命中自身=' + hit });
      })()`);
      return { ok: !!empty.ok && !!stars.ok, text: empty.text + ' ｜ ' + stars.text };
    }
  },
  {
    name: 'R6② 点星 ⇒ 自动弹框：真鼠标点第 4 颗星 ⇒ 反馈框 elementFromPoint 命中自身 + 标题口径 + 选项 data-signal 与页内纯函数现算逐项一致 + 候选数 ≤ 上限',
    run: async (ctx) => {
      const opened = await openBoxWithAnswer(ctx);
      if (!opened.ok) return { ok: false, text: opened.text };
      const pt = await realClickStar(ctx, 4);
      if (!pt.ok) return { ok: false, text: pt.text };
      const waited = await waitFor(ctx, `(function () {
        return JSON.stringify({ ok: !!document.querySelector('.fd-ask-box .ask-fb-panel'), text: '等反馈框' });
      })()`);
      if (!JSON.parse(waited).ok) return { ok: false, text: pt.text + ' ｜ 弹框没出现' };
      const chk = await execJson(ctx, `(function () {
        var box = document.querySelector('.fd-ask-box');
        var panel = box.querySelector('.ask-fb-panel');
        var r = panel.getBoundingClientRect();
        var at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        var hit = !!(at && panel.contains(at));
        var title = (panel.querySelector('.ask-fb-title') || {}).textContent || '';
        var opts = Array.prototype.slice.call(panel.querySelectorAll('.ask-fb-opt'));
        // 与产品自己的纯函数现算对拍（可指回信号 ✗ 写死/随机都会在这里红 —— text+signal 成对比，
        //   只对信号名会被"写死选项碰巧同名"骗过 ✗）
        var domPairs = opts.map(function (o) { return o.getAttribute('data-signal') + '|' + o.getAttribute('data-text'); });
        var b = window.MM.askBoxes()[0];
        var idx = Number(panel.getAttribute('data-fb-index'));
        var entry = b.ask.log[idx];
        var sig = window.MM.askCollectAnswerSignals(entry, b.ask);
        var cands = window.MM.askDeriveFeedbackCandidates(sig, entry.stars || 0);
        var expPairs = cands.map(function (c) { return c.signal + '|' + c.text; });
        var VOCAB = ['len', 'kind', 'code', 'mapWrite'];
        var inVocab = domPairs.every(function (p) { return VOCAB.indexOf(p.split('|')[0]) >= 0; });
        var other = !!panel.querySelector('.ask-fb-other');
        var fill4 = Array.prototype.slice.call(box.querySelectorAll('.ask-acts .ask-star'))
          .map(function (x) { return x.classList.contains('on') ? 1 : 0; }).join('');
        return JSON.stringify({
          ok: hit && title === '这次会话哪点让您不满意/满意？' && other
            && JSON.stringify(domPairs) === JSON.stringify(expPairs) && inVocab
            && cands.length <= window.MM.ASK_FB_MAX_CANDIDATES
            && panel.getAttribute('data-fb-star') === '4'
            && fill4 === '11110',
          text: '命中=' + hit + ' 标题=「' + title + '」 选项(text|信号)=[' + domPairs.join('；') + ']'
            + ' 纯函数现算=[' + expPairs.join('；') + '] 信号词表内=' + inVocab
            + ' 候选数=' + cands.length + '≤' + window.MM.ASK_FB_MAX_CANDIDATES
            + ' 星填充态=' + fill4 + ' 其他按钮=' + other
        });
      })()`);
      return { ok: !!chk.ok, text: pt.text + ' ｜ ' + chk.text };
    }
  },
  {
    name: 'R6②「其他」+文字落库：点「其他」⇒ 展开输入行、能输入；点亮一个选项 + 其他文本 ⇒ 提交 ⇒ 库里新增一条（stars + 选项文本；其他：…）',
    run: async (ctx) => {
      const opened = await openBoxWithAnswer(ctx);
      if (!opened.ok) return { ok: false, text: opened.text };
      const pt = await realClickStar(ctx, 4);
      if (!pt.ok) return { ok: false, text: pt.text };
      await waitFor(ctx, `(function () {
        return JSON.stringify({ ok: !!document.querySelector('.fd-ask-box .ask-fb-panel'), text: '等反馈框' });
      })()`);
      const act = await execJson(ctx, `(function () {
        var panel = document.querySelector('.fd-ask-box .ask-fb-panel');
        var opt = panel.querySelector('.ask-fb-opt');
        opt.click();                                        // 点亮第一个选项（多选语义 ✓）
        var on = opt.classList.contains('on');
        panel.querySelector('.ask-fb-other').click();       // 「其他」展开输入 ✓
        var row = panel.querySelector('.ask-fb-otherrow');
        var input = panel.querySelector('.ask-fb-other-input');
        var expanded = !row.hidden;
        input.value = '域50其他输入的话';
        return JSON.stringify({ ok: on && expanded, text: '选项点亮=' + on + ' 其他已展开=' + expanded,
          dataText: opt.getAttribute('data-text') });
      })()`);
      if (!act.ok) return { ok: false, text: act.text };
      S.pickedText = act.dataText;
      await execJson(ctx, `(function () {
        document.querySelector('.fd-ask-box .ask-fb-panel .ask-fb-submit').click();
        return 1;
      })()`);
      const wantText = S.pickedText + '；其他：域50其他输入的话';
      let got = null;
      for (let i = 0; i < 40; i++) {
        const fb = readFeedback(FEEDBACK_FILE);
        if (fb) {
          const hit = fb.lines.filter((l) => l && typeof l.text === 'string' && l.text.indexOf('域50其他输入的话') >= 0);
          if (hit.length) { got = hit[hit.length - 1]; break; }
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!got) return { ok: false, text: act.text + ' ｜ 库里没有出现文字反馈那行' };
      const KEYS = ['schema', 'id', 'at', 'stars', 'text', 'target', 'src'];
      const keysOk = KEYS.every((k) => k in got) && Object.keys(got).every((k) => KEYS.indexOf(k) >= 0);
      const ok = keysOk && got.stars === 4 && got.text === wantText && got.src === 'ask-box'
        && got.schema === 1 && !isNaN(Date.parse(got.at));
      return { ok: ok, text: act.text + ' ｜ 落库行 text=' + JSON.stringify(got.text).slice(0, 90)
        + ' stars=' + got.stars + ' 键齐全=' + keysOk + ' 期望=' + JSON.stringify(wantText).slice(0, 60) };
    }
  },
  {
    name: 'R6③ 落库契约：星击即刻落库（末行与点击一致、键白名单、src/target 正确、文件前缀逐字节保留）；再点第 5 颗星 ⇒ 多行且 id 各不相同（只追加 ✗ 不覆盖）',
    run: async (ctx) => {
      const opened = await openBoxWithAnswer(ctx);
      if (!opened.ok) return { ok: false, text: opened.text };
      const before = readFeedback(FEEDBACK_FILE);           // 本断言开工时的库（前面断言写过的行都要保留 ✓）
      const pt = await realClickStar(ctx, 4);
      if (!pt.ok) return { ok: false, text: pt.text };
      let after1 = null;
      for (let i = 0; i < 40; i++) {
        after1 = readFeedback(FEEDBACK_FILE);
        const n0 = before ? before.lines.length : 0;
        if (after1 && after1.lines.length > n0) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const n0 = before ? before.lines.length : 0;
      if (!after1 || after1.lines.length <= n0) return { ok: false, text: '点星后库里没有新增行' };
      const last1 = after1.lines[after1.lines.length - 1];
      const KEYS = ['schema', 'id', 'at', 'stars', 'text', 'target', 'src'];
      const keysOk = KEYS.every((k) => k in last1) && Object.keys(last1).every((k) => KEYS.indexOf(k) >= 0);
      // 只追加：新内容必须以开工时的旧内容为前缀（逐字节 ✗ 不覆盖）
      const prefixOk = !before || after1.raw.indexOf(before.raw) === 0;
      const pt2 = await realClickStar(ctx, 5);              // 再点第 5 颗 ⇒ 应新增一行（不覆盖 ✓）
      if (!pt2.ok) return { ok: false, text: pt2.text };
      let after2 = null;
      for (let i = 0; i < 40; i++) {
        after2 = readFeedback(FEEDBACK_FILE);
        if (after2 && after2.lines.length > after1.lines.length) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!after2 || after2.lines.length <= after1.lines.length) return { ok: false, text: '第二次点星没有新增行' };
      const last2 = after2.lines[after2.lines.length - 1];
      const ids = after2.lines.slice(n0).map((l) => l.id);
      const idsUnique = new Set(ids).size === ids.length;
      const ok = keysOk && last1.stars === 4 && last1.text === '' && last1.src === 'ask-box'
        && last1.target && last1.target.kind === 'node' && !!last1.target.nodeId
        && last2.stars === 5 && idsUnique && prefixOk;
      return { ok: ok, text: '新增 ' + (after2.lines.length - n0) + ' 行：stars=['
        + after2.lines.slice(n0).map((l) => l.stars).join(',') + '] id 唯一=' + idsUnique
        + ' 末行键齐全=' + keysOk + ' src=' + last1.src + ' target.kind=' + (last1.target && last1.target.kind)
        + ' nodeId=' + ((last1.target && last1.target.nodeId) || '').slice(0, 14)
        + ' 前缀逐字节保留=' + prefixOk };
    }
  },
  {
    name: 'R6⑤ 打分不改数据：打分全程项目 JSON sha256 逐字节不变；反馈文件不在 projects/** 之下（沙箱与真实两侧都现算）',
    run: async (ctx) => {
      const opened = await openBoxWithAnswer(ctx);
      if (!opened.ok) return { ok: false, text: opened.text };
      const shaBefore = sha256File(S.projFile);
      // 打一整轮分（点两颗星 + 开关反馈框）—— 全程不许碰项目数据
      const p1 = await realClickStar(ctx, 2);
      if (!p1.ok) return { ok: false, text: p1.text };
      const closed = await execJson(ctx, `(function () {
        var c = document.querySelector('.fd-ask-box .ask-fb-panel .ask-fb-close');
        if (c) c.click();                                    // 关 = 不反馈（星已落库 ✓ 判据15 的一半）
        return JSON.stringify({ ok: !document.querySelector('.fd-ask-box .ask-fb-panel'), text: '反馈框已关' });
      })()`);
      const p2 = await realClickStar(ctx, 3);
      if (!p2.ok) return { ok: false, text: p2.text };
      for (let i = 0; i < 40; i++) {
        const fb = readFeedback(FEEDBACK_FILE);
        if (fb && fb.lines.length && fb.lines[fb.lines.length - 1].stars === 3) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const shaAfter = sha256File(S.projFile);
      // 红线判据（现算）：反馈文件**绝不**落在真实 projects/** 之下；冒烟档的形状 =
      // "沙箱根下的一个旁路文件"（与项目目录**平级**，不在任何项目目录里 ⇒ 不进项目数据 ✗）
      const underRealProjects = FEEDBACK_FILE.indexOf(REAL_PROJECTS_ROOT) === 0;
      const siblingOfProjects = PROJECTS_DIR
        ? path.dirname(FEEDBACK_FILE) === PROJECTS_DIR
        : true;
      const ok = shaBefore !== null && shaBefore === shaAfter && !underRealProjects && siblingOfProjects && !!closed.ok;
      return { ok: ok, text: '项目 JSON sha256 前=' + String(shaBefore).slice(0, 12)
        + ' 后=' + String(shaAfter).slice(0, 12) + '（相等=' + (shaBefore === shaAfter) + '）'
        + ' ｜ 关反馈框=' + closed.text + ' ｜ 反馈文件在真实 projects/** 之下=' + underRealProjects
        + ' ｜ 冒烟档与项目目录平级（不在任何项目里）=' + siblingOfProjects
        + ' ｜ 点星落库 stars 末行=3' };
    }
  },
  {
    name: 'R6④ ⭐ 下次会话展示：node 侧直接往库里追加一条渲染层从没见过的行 ⇒ 关框重开会话 ⇒ 摘要条出现且行文本与库内容逐条相等（读文件 ✗ 不吃内存缓存）',
    run: async (ctx) => {
      const opened = await openBoxWithAnswer(ctx);
      if (!opened.ok) return { ok: false, text: opened.text };
      const pt = await realClickStar(ctx, 4);
      if (!pt.ok) return { ok: false, text: pt.text };
      for (let i = 0; i < 40; i++) {
        const fb = readFeedback(FEEDBACK_FILE);
        if (fb && fb.lines.length) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const before = readFeedback(FEEDBACK_FILE);
      if (!before || !before.lines.length) return { ok: false, text: '点星没有落库，没法做"下次展示"对照' };
      // 库里追加一条**渲染层从没见过**的行（此刻渲染层内存里没有它 ⇒ 重开后出现在摘要条 = 一定读的是文件 ✓）
      const foreign = {
        schema: 1, id: 'f-dom50' + Date.now().toString(36), at: new Date().toISOString(),
        stars: 5, text: '域50外部直接写入库的一行（渲染层从没见过）',
        target: { kind: 'project', project: (S.projFile ? path.basename(path.dirname(S.projFile)) : '?') },
        src: 'ask-box'
      };
      fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(foreign) + '\n', 'utf8');
      // 关框（产品自己的关闭路径）→ 重开 = 新会话 ⇒ 应该把库里的最新内容展示出来
      await ctx.exec(`(function () {
        Array.prototype.slice.call(document.querySelectorAll('.fd-ask-box .fd-close')).forEach(function (b) { b.click(); });
        return 1;
      })()`);
      await new Promise((r) => setTimeout(r, 200));
      await ctx.exec(`window.MM.showAskBox(${JSON.stringify(opened.node.id)}, { kind: 'ask' }); 1`);
      const placed = await placeBoxIntoView(ctx);   // 重开也是新框 ⇒ 默认落点同样要摆进可视区 ✓
      if (!placed.ok) return { ok: false, text: '重开后框摆不进可视区：' + placed.text };
      const waited = await waitFor(ctx, `(function () {
        return JSON.stringify({ ok: !!document.querySelector('.fd-ask-box .ask-fb-summary'), text: '等摘要条' });
      })()`);
      if (!JSON.parse(waited).ok) return { ok: false, text: '重开会话后摘要条没出现' };
      const chk = await execJson(ctx, `(function () {
        var box = document.querySelector('.fd-ask-box');
        var strip = box.querySelector('.ask-fb-summary');
        strip.scrollIntoView({ block: 'center' });
        var r = strip.getBoundingClientRect();
        var at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        var hit = !!(at && strip.contains(at));
        var lines = Array.prototype.slice.call(strip.querySelectorAll('.ask-fb-sum-line')).map(function (x) { return x.textContent; });
        var head = (strip.querySelector('.ask-fb-sum-head span') || {}).textContent || '';
        return JSON.stringify({ ok: hit, hit: hit, head: head, lines: lines,
          text: '命中=' + hit + ' 头=「' + head + '」 行数=' + lines.length });
      })()`);
      const o = chk;   // execJson 已解析（不要二次 parse ✗ —— 上一版在这里 throw）
      // 与库内容逐条对拍（同样的显示规则在 node 侧重算 —— 内容 == 库里那条 ✓；
      //   展示面只显示最近 5 条 ⇒ 对拍也取最近 5 条，"共几条"单独对头部计数 ✓）
      const allLines = before.lines.concat([foreign]);
      const total = allLines.length;
      const exp = allLines.slice(-5).map((l) => {
        const n = Number(l.stars);
        const starStr = (l.stars === null || l.stars === undefined || !(n >= 1 && n <= 5)) ? '☆' : '★★★★★'.slice(0, n);
        const raw = String(l.text || '');
        return starStr + ' ' + (raw || '（只点星，没写文字）');
      });
      const linesEq = JSON.stringify(o.lines) === JSON.stringify(exp);
      const headOk = o.head.indexOf('本机共 ' + total + ' 条') >= 0;
      return { ok: !!o.ok && linesEq && headOk, text: o.text + ' ｜ 行文本与库逐条相等=' + linesEq
        + ' 头部计数对=' + headOk + '（库里共 ' + total + ' 条，展示最近 ' + exp.length + ' 条）' };
    }
  },
  {
    name: 'R6⑦ 默认档：删掉反馈文件 ⇒ 重开会话摘要条如实消失、读取返回 missing（不说"0 条" ✗ 不编数据）',
    run: async (ctx) => {
      try { fs.rmSync(FEEDBACK_FILE, { force: true }); } catch (e) { /* 不存在即正常 */ }
      await ctx.exec(`(function () {
        Array.prototype.slice.call(document.querySelectorAll('.fd-ask-box .fd-close')).forEach(function (b) { b.click(); });
        return 1;
      })()`);
      await new Promise((r) => setTimeout(r, 200));
      const pick = await pickVisibleNode(ctx);
      if (!pick.ok) return { ok: false, text: pick.text };
      await ctx.exec(`window.MM.showAskBox(${JSON.stringify(pick.node.id)}, { kind: 'ask' }); 1`);
      await new Promise((r) => setTimeout(r, 900));         // 等读库那一跳走完（missing ⇒ 什么都不长 ✓）
      const chk = await execJson(ctx, `(function () {
        var box = document.querySelector('.fd-ask-box');
        return JSON.stringify({ ok: !!box,
          strip: !!box.querySelector('.ask-fb-summary'),
          stars: box.querySelectorAll('.ask-stars').length,
          read: null });
      })()`);
      const rd = await execJson(ctx, `(async function () {
        var r = await window.MM.askFeedbackStore.read();
        return JSON.stringify({ ok: true, missing: r.missing === true, okFlag: r.ok === true, text: r.text || '' });
      })()`);
      const ok = chk.ok && !chk.strip && chk.stars === 0 && rd.missing && rd.okFlag && rd.text === '';
      return { ok: ok, text: '删库后重开：摘要条=' + chk.strip + '（应 false） 星标组=' + chk.stars
        + '（应 0，空框无回答） 读取 missing=' + rd.missing + ' ok=' + rd.okFlag
        + ' text 长度=' + rd.text.length + '（应 0 —— 如实说"没有"，不说"0 条满意度" ✗）' };
    }
  },
  {
    name: 'R6 补A（本批拍板）：--smoke 全程真实 %APPDATA% 侧 mm-feedback.jsonl 逐字节不变（存在性/哈希与开工快照一致）',
    run: async (ctx) => {
      const realNow = { exists: fs.existsSync(REAL_FEEDBACK_FILE), sha: sha256File(REAL_FEEDBACK_FILE) };
      const same = realNow.exists === S.real0.exists && realNow.sha === S.real0.sha;
      const sandboxed = FEEDBACK_FILE.indexOf(path.join(process.env.APPDATA || '', 'AI MindMap')) !== 0;
      return { ok: same && sandboxed,
        text: '真实侧开工=' + JSON.stringify(S.real0) + ' 收工=' + JSON.stringify(realNow)
          + '（逐字节一致=' + same + '） ｜ 冒烟写的不是真实侧路径=' + sandboxed };
    }
  },
  {
    name: 'R6 补B（结构）：main.js 反馈路径推导与 append handler 都不含 projects/**；渲染层 0 处 localStorage；preload 两条纯透传',
    run: async (ctx) => {
      const mainSrc = fs.readFileSync(path.join(REPO_ROOT, 'main.js'), 'utf8');
      const i1 = mainSrc.indexOf('function feedbackFile()');
      const i2 = mainSrc.indexOf('function feedbackRecordForAppend');
      const i3 = mainSrc.indexOf("app:feedback-append");
      const i4 = mainSrc.indexOf('ipcMain.handle(', i3);
      if (i1 < 0 || i2 < 0 || i3 < 0 || i4 < 0) return { ok: false, text: 'main.js 里找不到反馈路径推导/append handler（结构变了？）' };
      const fbFn = mainSrc.slice(i1, i2);
      const appendBlk = mainSrc.slice(i3, i4);
      const fbClean = fbFn.indexOf('projects') < 0 && fbFn.indexOf('PROJECTS_DIR') < 0
        && fbFn.indexOf('SMOKE_FEEDBACK_FILE') >= 0 && fbFn.indexOf("getPath('userData')") >= 0;
      const apClean = appendBlk.indexOf('projects') < 0 && appendBlk.indexOf('PROJECTS_DIR') < 0
        && appendBlk.indexOf('feedbackFile()') >= 0 && appendBlk.indexOf('appendFileSync') >= 0
        && appendBlk.indexOf('feedbackRecordForAppend') >= 0;
      const preSrc = fs.readFileSync(path.join(REPO_ROOT, 'preload.js'), 'utf8');
      const cnt = (s, needle) => s.split(needle).length - 1;
      const preOk = cnt(preSrc, "ipcRenderer.invoke('app:feedback-append'") === 1
        && cnt(preSrc, "ipcRenderer.invoke('app:feedback-read'") === 1
        && /\r?\n\s*feedbackAppend: \(record\) => ipcRenderer\.invoke\('app:feedback-append', record\),\r?\n/.test(preSrc)
        && /\r?\n\s*feedbackRead: \(\) => ipcRenderer\.invoke\('app:feedback-read'\),\r?\n/.test(preSrc);
      const rdir = path.join(REPO_ROOT, 'renderer');
      const rfiles = fs.readdirSync(rdir).filter((f) => /\.js$/.test(f));
      // 判"使用"而不是判"提到"：注释里引用这条纪律（"渲染层 0 处 …"）不算使用 ✗
      const USE_LS = [/localStorage\s*\./i, /localStorage\s*\[/i, /window\.localstorage\s*=/i];
      const lsHits = rfiles.filter((f) => {
        const src = fs.readFileSync(path.join(rdir, f), 'utf8');
        return USE_LS.some((re) => re.test(src));
      });
      const ok = fbClean && apClean && preOk && lsHits.length === 0;
      return { ok: ok, text: 'feedbackFile() 无 projects 引用且双分支=' + fbClean
        + ' ｜ append handler 纯净=' + apClean
        + ' ｜ preload 恰好两条纯透传=' + preOk
        + ' ｜ renderer ' + rfiles.length + ' 个 js 里 localStorage 命中=' + (lsHits.join(',') || '无') };
    }
  },
  {
    name: 'R6 收尾：关掉本域开过的所有问答浮层（不留残影给收尾检查）',
    run: async (ctx) => {
      const cleaned = await execJson(ctx, `(function () {
        Array.prototype.slice.call(document.querySelectorAll('.fd-ask-box .fd-close')).forEach(function (b) { b.click(); });
        return JSON.stringify({ ok: true, left: document.querySelectorAll('.fd-ask-box').length });
      })()`);
      const mm = require('../smoke-assertions.js');
      const dlg = await mm.closeDialogs(ctx);
      return { ok: cleaned.ok && cleaned.left === 0,
        text: '问答浮层剩=' + cleaned.left + ' ｜ 模态收尾=' + dlg.n + ' 个' };
    }
  }
];
