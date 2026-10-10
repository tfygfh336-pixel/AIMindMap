/* ============================================================
 * scripts/smoke/38-ai-落盘.js — AI 产出**落到节点上**的界面侧（功能 1 的下半截，A）
 * ------------------------------------------------------------
 * 为什么需要这一域：集成断言（`scripts/cli-integration.js` 第 46 段）只验得到**数据侧**真值
 *（`ask-apply` 真的把 qa/详情/子节点写进盘了 ✓）。而 A 这个功能的验收还有**界面侧**那一半，
 * 它只能在这里验：
 *   ① 界面上的动作真的走到了 CLI（写盘）——不是只弹了个提示说"已保存"；
 *   ② 写完之后**界面自己**也变了（内存对齐 + 按磁盘重读 ⇒ 新子节点出现在导图上）；
 *   ③ 失败路径**如实报**（空回答 / 回执说没成功）——**不许静默假装成功**。
 *
 * 判据纪律（本域的核心）：**盘上的字节** + **界面上的 DOM**，两样都要。
 *   只判 DOM → 抓不到"界面说成功了、盘上什么都没有"（本工程最重的损害类别）；
 *   只判盘 → 抓不到"写进去了但界面还显示旧的"（下一次界面保存会把刚落盘的问答抹掉 ⇒ 断言⑤专治它）。
 *
 * ⚠️ 本域**不调模型**（门禁纪律）：回答是**喂进流水**的夹具，不是问出来的。
 *   "问答浮窗本身通不通"由 26 域覆盖；这里只验"拿到回答之后，它怎么落到节点上"。
 * ⚠️ 数据：**运行时用 CLI 建自己的夹具节点**（不写死 id、不依赖别人留下的树 ——
 *    26 域文件头里记着的那次教训：写死 id 必红，因为前面的域会删节点）。
 * ⚠️ 每段渲染层脚本都包 try/catch：`executeJavaScript` 里抛错只会回一句
 *    "Script failed to execute"（**看不见真正的原因**），排查代价极高 ⇒ 自己把原因带出来。
 * ============================================================ */
'use strict';

// 冒烟共用工具（收尾纪律与用法见 scripts/smoke-assertions.js 顶部）：动了 addNode 就要收模态
const mm = require('../smoke-assertions.js');

/** 夹具节点的前缀（便于人工核对"这些是冒烟造的"；沙箱副本里，每域隔离会还原） */
const FIX = 'smoke-qa-';
/** 传进界面的回答文本（首行会被拿去当子节点标题 ⇒ 写长一点，才能验到"截断"这件事） */
const ANSWER1 = '三次握手是为了同步双方的初始序号：双方各发一个自己的序号并确认对方的。\n第二行是正文，应该完整进详情，不该出现在标题里。';
const ANSWER2 = '第二次回答：把结论写进详情末尾即可。';
/** 与 ANSWER1 首行**逐字相同**（断言②拿它判"标题取首行"） */
const ANSWER1_FIRST_LINE = '三次握手是为了同步双方的初始序号：双方各发一个自己的序号并确认对方的。';

/** 在渲染层执行并解析 JSON（解析不出来也算一种失败，带原文回来） */
async function execJson(ctx, js) {
  const raw = await ctx.exec(js);
  try { return JSON.parse(raw); } catch (e) { return { ok: false, text: '返回值不是 JSON：' + String(raw).slice(0, 300) }; }
}

/** 等一个判据成立（默认 ~3s）：写盘 → IPC → 重渲染 需要几拍 */
async function waitFor(ctx, js, tries) {
  let last = '';
  for (let i = 0; i < (tries || 15); i++) {
    try { last = await ctx.exec(js); } catch (e) { last = JSON.stringify({ ok: false, text: '执行异常：' + ((e && e.message) || e) }); }
    try { if (JSON.parse(last).ok) return JSON.parse(last); } catch (e) { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  try { return JSON.parse(last); } catch (e) { return { ok: false, text: String(last).slice(0, 200) }; }
}

/** 建夹具节点（用 CLI ⇒ 与真实用户的"新建节点"同一条写盘路径），再让界面**重载项目**读到它。
 *  ⚠️ 必须显式重载：`ctx.runCli` 直接写盘 ⇒ fs.watch 那条路有 300ms 防抖，
 *     而"改盘之后界面刚好看得见"是这一域的**前提**（第一版没重载 ⇒ 夹具节点在界面上根本不存在 ⇒ 全红） */
async function setupNode(ctx, id, topic) {
  try { ctx.runCli(['remove', 'comnet', id]); } catch (e) { /* 不存在就算了（本域自己幂等） */ }
  ctx.runCli(['add', 'comnet', 'root', '--topic', topic, '--id', id]);
  return execJson(ctx, `(async function () {
    try {
      await window.MMApp.openProject('comnet');
    } catch (e) { return JSON.stringify({ ok: false, text: '重载项目失败：' + ((e && e.message) || e) }); }
    var jm = window.MMApp.getState().jm;
    var n = jm && jm.get_node(${JSON.stringify(id)});
    return JSON.stringify({ ok: !!n, text: n ? '夹具节点已进界面' : '界面重载后仍然没有夹具节点' });
  })()`);
}

/** 取/建该节点的问答框。**必须复用**同一个框对象：
 *  `showAskBox` 只保证"屏幕上有一个该节点的框"，它**不保证**返回的是上次那一个
 *  （框被关掉/被别处重渲染之后，它会新建一个）—— 第一版每次操作都重开一个，
 *  于是"写进去的留痕"与"读出来的框"可能不是同一个 ✗（实测就在这里绕了很久）。
 *  真实用例里用户点的就是眼前那个框，所以夹具也必须**拿住同一个**。 */
async function askBox(ctx, nodeId) {
  return execJson(ctx, `(function () {
    try {
      var box = window.__mmAskBox || window.MM.showAskBox(${JSON.stringify(nodeId)}, { kind: 'ask', focus: false });
      if (!box || !box.el) return JSON.stringify({ ok: false, text: '没拿到问答浮窗' });
      window.__mmAskBox = box;
      return JSON.stringify({ ok: true, text: '拿到问答浮窗' });
    } catch (e) { return JSON.stringify({ ok: false, text: '渲染层报错：' + ((e && e.message) || e) }); }
  })()`);
}

/** 打开问答浮窗、把一条"回答"喂进流水（不调模型）。
 *  一律用 `kind:'ask'` + `focus:false`：`explain` 会**自动发一次**（异步），
 *  那会在断言之后才落地、把流水覆盖掉 ✗ */
async function seedAnswer(ctx, nodeId, question, answer) {
  return execJson(ctx, `(function () {
    try {
      var box = window.MM.showAskBox(${JSON.stringify(nodeId)}, { kind: 'ask', focus: false });
      if (!box || !box.el) return JSON.stringify({ ok: false, text: '没拿到问答浮窗' });
      window.__mmAskBox = box;              // 本段之后一律复用这一个（见 askBox 的说明）
      var st = box.ask || (box.ask = { kind: 'ask', log: [] });
      st.log = [{ q: ${JSON.stringify(question)}, a: ${JSON.stringify(answer)} }];
      st.lastWrite = null;
      window.MM.renderAskPage(box);
      var acts = box.el.querySelectorAll('.ask-acts .ask-act');
      return JSON.stringify({ ok: acts.length === 2, text: '落盘动作按钮=' + acts.length + ' 个' });
    } catch (e) { return JSON.stringify({ ok: false, text: '渲染层报错：' + ((e && e.message) || e) }); }
  })()`);
}

/** 开一个 100ms 采样器，把 `lastWrite` 的**变化轨迹**记下来。
 *  它能区分两种完全不同的故障："从来没写上"（writeBack 的成功分支没跑到）
 *  与"写上了、又被后面的重读弄丢了"（诊断信息直接可读，不用再猜） */
const SAMPLER = [
  '(function () {',
  '  var box = window.__mmAskBox;',
  '  if (!box) return;',
  '  box.__mmProbe = true;',
  '  window.__mmWriteSamples = [];',
  '  (function sample() {',
  '    try {',
  '      var cur = window.__mmAskBox;',
  '      window.__mmWriteSamples.push({',
  '        n: window.__mmWriteSamples.length,',
  '        last: cur.ask && cur.ask.lastWrite ? String(cur.ask.lastWrite.text).slice(0, 36) : null,',
  '        log: (cur.ask && cur.ask.log) ? cur.ask.log.length : -1',
  '      });',
  '    } catch (e) { /* ignore */ }',
  '    if (box.__mmProbe && window.__mmWriteSamples.length < 150) setTimeout(sample, 100);',
  '  })();',
  '})();'
].join('\n');

/** 点某个落盘动作（**走真实的点击路径**：按钮存在 + 事件接线真的挂上了，两件事一起验） */
async function clickAction(ctx, nodeId, act) {
  return execJson(ctx, `(function () {
    try {
      var box = window.__mmAskBox || window.MM.showAskBox(${JSON.stringify(nodeId)}, { kind: 'ask', focus: false });
      if (!box || !box.el) return JSON.stringify({ ok: false, text: '没有浮窗' });
      window.__mmAskBox = box;
      var btn = box.el.querySelector('.ask-act[data-act="' + ${JSON.stringify(act)} + '"]');
      if (!btn) return JSON.stringify({ ok: false, text: '没有这个动作按钮：' + ${JSON.stringify(act)} });
      ${SAMPLER}
      btn.click();
      return JSON.stringify({ ok: true, text: '已点击 ' + ${JSON.stringify(act)} });
    } catch (e) { return JSON.stringify({ ok: false, text: '渲染层报错：' + ((e && e.message) || e) }); }
  })()`);
}

/** 读浮窗里的落盘留痕（`.ask-write-note`）：成功/失败都必须**留在框里**
 *  —— 状态栏那句会被下一条动作覆盖，说过就没了 ✗
 *  失败时把 `lastWrite` 的采样轨迹 + **框对象身份**一并带回
 *  （否则只看到"没有留痕"，无从下手 —— 实测这里就踩过一次：写上了，但读的是另一个框对象） */
async function readNote(ctx, nodeId) {
  return waitFor(ctx, `(function () {
    try {
      var box = window.__mmAskBox;
      if (!box || !box.el) return JSON.stringify({ ok: false, text: '没有手上的问答浮窗' });
      var note = box.el.querySelector('.ask-write-note');
      var st = box.ask || null;
      var s = window.__mmWriteSamples || [];
      var seen = s.filter(function (x) { return x.last !== null; });
      var trail = '采样' + s.length + '点/其中非空' + seen.length + '点'
        + (seen.length ? ('（末="' + String(seen[seen.length - 1].last).slice(0, 24) + '…"）') : '');
      var now = (st && st.lastWrite) ? String(st.lastWrite.text).slice(0, 40) : null;
      if (box) box.__mmProbe = false;
      var diag = 'lastWrite(now)=' + now + ' ｜ ' + trail;
      if (!note) return JSON.stringify({ ok: false, diag: diag, text: '浮窗里没有落盘留痕' });
      var err = /ask-write-err/.test(note.className);
      return JSON.stringify({ ok: true, err: err, diag: diag,
        text: (err ? '[失败] ' : '[成功] ') + note.textContent });
    } catch (e) { return JSON.stringify({ ok: false, text: '渲染层报错：' + ((e && e.message) || e) }); }
  })()`);
}

/** 从盘上读节点真值（经 CLI ⇒ 与外部 AI 读到的是同一个东西） */
function diskNode(ctx, id) {
  try { return JSON.parse(ctx.runCli(['get', 'comnet', id, '--json', '--detail'])); }
  catch (e) { return null; }
}

/**
 * 从盘上（经 CLI）取某节点的**直接子节点 id 列表**。
 * ⚠️ 两个坑（第一版各踩一次，两条断言因此恒红而原因看不出来）：
 *   ① `get --json` 的视图**不带** children（`getNodeView` 是"节点实况"视图，见 src/query.js）；
 *   ② `read --json` 返回的**不是树**，是 `{meta, nodeCount, nodes:[扁平表], images}`
 *      （扁平表里每项有 id/topic/depth）⇒ 直接子节点 = 紧随其后、depth 恰好 +1 的那一段。
 */
function childIdsFromDisk(ctx, parentId) {
  try {
    const view = JSON.parse(ctx.runCli(['read', 'comnet', '--json']));
    const nodes = Array.isArray(view.nodes) ? view.nodes : [];
    const at = nodes.findIndex((n) => n.id === parentId);
    if (at < 0) return [];
    const d = nodes[at].depth;
    const out = [];
    for (let i = at + 1; i < nodes.length; i++) {
      if (nodes[i].depth <= d) break;
      if (nodes[i].depth === d + 1) out.push(nodes[i].id);
    }
    return out;
  } catch (e) { return []; }
}

module.exports = [
  {
    name: 'AI 落盘①：点「写入本节点详情」⇒ **盘上真的多了 qa 记录与详情**（不是只弹了个提示），来源标记可见',
    run: async (ctx) => {
      const id = FIX + 'a';
      const setup = await setupNode(ctx, id, '冒烟·问答落盘A');
      if (!setup.ok) return { ok: false, text: setup.text };
      const seeded = await seedAnswer(ctx, id, '为什么要三次握手？', ANSWER1);
      if (!seeded.ok) return { ok: false, text: seeded.text };
      const clicked = await clickAction(ctx, id, 'detail');
      if (!clicked.ok) return { ok: false, text: clicked.text };

      // ① 盘上真值 —— **这是"写盘真的走了 CLI"的直接证据**
      const disk = diskNode(ctx, id);
      const qa = (disk && Array.isArray(disk.qa)) ? disk.qa : [];
      const detail = (disk && typeof disk.detail === 'string') ? disk.detail : '';
      const hasAnswer = detail.indexOf('三次握手是为了同步双方的初始序号') >= 0;
      const hasMark = /🤖 AI 问答/.test(detail);
      const diskOk = qa.length === 1 && qa[0].a === ANSWER1 && qa[0].q === '为什么要三次握手？'
        && typeof qa[0].at === 'string' && qa[0].at.trim() !== ''   // at 必须是真给的时间戳（不是空串）
        && hasAnswer && hasMark;
      // ② 界面上的留痕（成功样式 + 说的是"已落盘"）
      const note = await readNote(ctx, id);
      const uiOk = !!note.ok && note.err === false && note.text.indexOf('已落盘') >= 0;
      return {
        ok: !!diskOk && uiOk,
        text: '盘上 qa=' + qa.length + ' 条 · 详情含回答=' + hasAnswer + ' · 含来源标记=' + hasMark
          + ' ｜ ' + (note.text || '没有留痕') + ' ｜ ' + (note.diag || '')
      };
    }
  },
  {
    name: 'AI 落盘②：点「新建子节点」⇒ **子节点真的落盘**（标题取首行、详情放全文）**且出现在导图上**（界面侧也变了）',
    run: async (ctx) => {
      const id = FIX + 'b';
      const setup = await setupNode(ctx, id, '冒烟·问答落盘子节点');
      if (!setup.ok) return { ok: false, text: setup.text };
      const seeded = await seedAnswer(ctx, id, '给我一个子节点', ANSWER1);
      if (!seeded.ok) return { ok: false, text: seeded.text };
      const clicked = await clickAction(ctx, id, 'child');
      if (!clicked.ok) return { ok: false, text: clicked.text };
      // 子节点是**异步**建出来的（IPC → CLI → 回读 → 重读）⇒ 等它出现在盘上
      let kidId = null;
      for (let i = 0; i < 20 && !kidId; i++) {
        const kids = childIdsFromDisk(ctx, id);
        if (kids.length) { kidId = kids[0]; break; }
        await new Promise((r) => setTimeout(r, 200));
      }
      const kidDisk = kidId ? diskNode(ctx, kidId) : null;
      const title = (kidDisk && kidDisk.topic) || '';
      // 界面侧：新子节点必须**出现在导图上**（内存对齐 + 按磁盘重读都到位才有这个结果）
      const cv = kidId ? await waitFor(ctx, `(function () {
        var el = document.querySelector('jmnode[nodeid="' + ${JSON.stringify(kidId)} + '"]');
        return JSON.stringify({ ok: !!el, text: el ? '导图上有这个节点' : '导图上还没有这个节点' });
      })()`)
        : { ok: false, text: '盘上没长出子节点 ⇒ 不用看导图了' };
      const diskOk = !!kidDisk
        && title === ANSWER1_FIRST_LINE          // 标题 = 回答首行（与夹具逐字相同）
        && title.indexOf('第二行') < 0            // 只有首行，正文没跑进标题
        && String(kidDisk.detail || '').indexOf('第二行') >= 0;   // 详情放全文
      const parent = diskNode(ctx, id);            // 父节点实况（qa 记录要落在它身上）
      const parentOk = !!(parent && Array.isArray(parent.qa) && parent.qa.length === 1);
      return {
        ok: !!diskOk && parentOk && !!cv.ok,
        text: '子节点=' + kidId + ' 标题「' + title.slice(0, 16) + '…」 · 标题只取首行='
          + (title.indexOf('第二行') < 0) + ' · 详情含正文=' + (String(kidDisk && kidDisk.detail).indexOf('第二行') >= 0)
          + ' · 父节点 qa=' + ((parent && parent.qa) ? parent.qa.length : 0) + ' ｜ ' + cv.text
      };
    }
  },
  {
    name: 'AI 落盘③（**判别力**）：空回答不许落盘 —— 盘上零改动，且界面**说出原因**（不许静默假装成功 ✗）',
    run: async (ctx) => {
      const id = FIX + 'c';
      const setup = await setupNode(ctx, id, '冒烟·问答落盘C');
      if (!setup.ok) return { ok: false, text: setup.text };
      // 夹具：流水里放一条**只有空白**的回答。第一道拦截在渲染层（按钮只在有回答时才出现），
      // 这条断言走的是"按钮在、但回答是空白"的兜底 —— 判据是**盘上零改动 + 界面说原因** ✓
      const seeded = await seedAnswer(ctx, id, '空回答应该被拒', '   ');
      if (!seeded.ok) return { ok: false, text: '夹具没就位（不是断言失败，是跑不起来）：' + seeded.text };
      const clicked = await clickAction(ctx, id, 'detail');
      if (!clicked.ok) return { ok: false, text: clicked.text };
      const note = await readNote(ctx, id);
      const disk = diskNode(ctx, id);
      const untouched = !!disk && !disk.qa && !String(disk.detail || '').trim();
      return {
        ok: !!note.ok && note.err === true && untouched,
        text: '界面留痕=' + (note.text || '无') + ' ｜ ' + (note.diag || '') + ' ｜ 盘上零改动=' + untouched
      };
    }
  },
  {
    name: 'AI 落盘④（**判别力**）：落盘失败 ⇒ 界面**如实报错**并把原因留在框里、盘上零改动（不把失败说成成功 ✗）',
    run: async (ctx) => {
      const id = FIX + 'd';
      const setup = await setupNode(ctx, id, '冒烟·问答落盘D');
      if (!setup.ok) return { ok: false, text: setup.text };
      const seeded = await seedAnswer(ctx, id, '这条不该落盘', '这条回答不该落盘');
      if (!seeded.ok) return { ok: false, text: seeded.text };
      // 可复现的失败路径：把浮窗的 `node` 换成**没有节点**（等价于项目级 / 多节点提问 ——
      // 那种问答没有明确落点，必须**如实拒绝**而不是猜一个节点写进去）。
      // 这是渲染层能自己判定的那一道；主进程/CLI 侧的那道由集成断言（第 46 段 46.6/46.7）守着。
      const clicked = await execJson(ctx, `(function () {
        try {
          var box = window.__mmAskBox;
          if (!box || !box.el) return JSON.stringify({ ok: false, text: '没有手上的问答浮窗' });
          box.__savedNode = box.node;      // 记下来，稍后还原（别污染后面的断言）
          box.node = null;
          var btn = box.el.querySelector('.ask-act[data-act="detail"]');
          if (!btn) return JSON.stringify({ ok: false, text: '没有动作按钮' });
          ${SAMPLER}
          btn.click();
          return JSON.stringify({ ok: true, text: '已制造"没有落点"并点击' });
        } catch (e) { return JSON.stringify({ ok: false, text: '渲染层报错：' + ((e && e.message) || e) }); }
      })()`);
      if (!clicked.ok) return { ok: false, text: clicked.text };
      const note = await readNote(ctx, id);
      // 还原：把节点放回去（后续断言还要用这个框）
      await execJson(ctx, `(function () {
        var box = window.__mmAskBox;
        if (box && box.__savedNode) { box.node = box.__savedNode; delete box.__savedNode; }
        return JSON.stringify({ ok: true, text: '已还原' });
      })()`);
      const disk = diskNode(ctx, id);
      const untouched = !!disk && !disk.qa && !String(disk.detail || '').trim();
      return {
        ok: !!note.ok && note.err === true && note.text.indexOf('没有落到任何节点') >= 0 && untouched,
        text: '界面留痕=' + (note.text || '无') + ' ｜ ' + (note.diag || '') + ' ｜ 盘上零改动=' + untouched
      };
    }
  },
  {
    name: 'AI 落盘⑤（**判别力**）：写盘后界面内存已对齐 —— 紧接着让界面自己保存一次，盘上的 qa 不许被抹掉',
    run: async (ctx) => {
      const id = FIX + 'e';
      const setup = await setupNode(ctx, id, '冒烟·问答落盘E');
      if (!setup.ok) return { ok: false, text: setup.text };
      const seeded = await seedAnswer(ctx, id, '这条要写进去', ANSWER2);
      if (!seeded.ok) return { ok: false, text: seeded.text };
      const clicked = await clickAction(ctx, id, 'detail');
      if (!clicked.ok) return { ok: false, text: clicked.text };
      const note = await readNote(ctx, id);
      if (!note.ok || note.err !== false) return { ok: false, text: '前置没成立（写入没成功）：' + (note.text || '') + ' ｜ ' + (note.diag || '') };

      // 关键动作：**让界面自己保存一次**（内存 → 盘）。渲染层没对齐内存、或 `serializeTree`
      // 漏带 `qa` 的话，这次保存会把刚落盘的问答记录静默抹掉 —— 这正是"只看盘就抓不到"的那半边。
      // ⚠️ 保存前先制造一个**真实改动**：`save()` 在没有改动时可能直接返回（`renderMind` 不重跑），
      //    那样"字段没丢"是因为"根本没写盘"，而不是因为序列化带上了它 —— 那就是**假绿**
      //    （本工程在 localPath 那次踩过同一个坑，smoke/16 的做法照抄：制造改动 ⇒ 保存 ⇒ 撤销回归）
      const so = await execJson(ctx, `(async function () {
        try {
          var app = window.MMApp;
          if (!app || typeof app.save !== 'function') return JSON.stringify({ ok: false, text: '没有 MMApp.save 入口' });
          app.addNode(${JSON.stringify(id)});      // 制造一个真实改动（一个新子节点）
          var saved = await app.save();
          return JSON.stringify({ ok: saved === true, text: 'save() 返回 ' + saved });
        } catch (e) { return JSON.stringify({ ok: false, text: '保存报错：' + ((e && e.message) || e) }); }
      })()`);
      if (!so.ok) return { ok: false, text: '保存没真的发生 ⇒ 这条断言无效（不是通过）：' + so.text };
      await new Promise((r) => setTimeout(r, 600));   // 等写盘落地（原子写 + 版本推进）
      const disk = diskNode(ctx, id);
      const qa = (disk && Array.isArray(disk.qa)) ? disk.qa : [];
      const detail = String((disk && disk.detail) || '');
      const survived = qa.length === 1 && qa[0].a === ANSWER2 && detail.indexOf('第二次回答') >= 0;
      // 反向证据：这次保存**确实写盘了**（子节点数从 0 变成 1 —— 证明走的不是"没改动的空保存"）
      const kids = childIdsFromDisk(ctx, id);
      // 收尾：`addNode` 会顺手打开「编辑节点」模态 ⇒ 当场关掉（跨域存活会盖住后面的真输入域；
      // 共用工具见 scripts/smoke-assertions.js 的「收尾纪律」）
      const closed = await mm.closeDialogs(ctx);
      return {
        ok: survived && kids.length >= 1,
        text: so.text + ' ｜ 保存后盘上 qa 仍在=' + survived + '（条数=' + qa.length + '）'
          + ' ｜ 这次保存真的写了盘（子节点=' + kids.length + '）'
          + ' ｜ 收尾关掉的模态=' + closed.n
      };
    }
  }
];
