/* ============================================================
 * scripts/smoke/35-rel-edit.js — 「关联信息」编辑条（关联视图里的人工编辑）
 * ------------------------------------------------------------
 * 用户需求（原话）："进入关联视图后能人工编辑关联信息"。已确认范围 =
 * **加/删链接 + 新建关联笔记**（此前：补链接只有关系审计面板有、删链接只有 CLI、
 * 关联笔记只能改 AI 写好的那篇 —— 界面**没有创建入口** ✗）。
 *
 * 覆盖五条，每条都判**可观测副作用**（不是"命令没报错"）：
 *   1) 进关联视图 ⇒ 出现编辑条：可见、在面板内、带中心节点标题、有出边/入边两组；
 *      并且**节点没被它盖住**（fit 让出了它的高度 —— "刚好框住"不能名不副实）
 *   2) 「➕ 添加链接」输入即搜：用**不连续子序列**查询也能命中目标
 *      （等价子串匹配会落空 ⇒ 这条判的是"真的用了共享的模糊排序"，不是随便写了个 indexOf）
 *   3) 添加链接 ⇒ **界面侧**（清单多一行 + 内存树 data.links 有它）与
 *      **数据侧**（CLI `links --json` 读回）**两侧都变**
 *   4) 删链接 ⇒ **自证**（CLI 读回：那条边没了）+ **自清**（内存树里也没了）
 *   5) 「📝 新建关联笔记」⇒ CLI 读回有它、「关联笔记（N）」清单里出现它
 *
 * 数据：跑在**冒烟沙箱副本**上（`ctx.runCli` 与主进程的 PROJECTS_DIR 都已指向副本，
 * 见 main.js 顶部 SMOKE_PROJECTS_DIR），不碰真实数据 ✓。
 * ⚠️ 不写死节点名、也不自己造节点 —— 与 25 域同一条教训：
 *   · 写死会在全量运行里红（前面的域会删节点、且每域隔离会还原），单跑却绿 ⇒ 顺序依赖；
 *   · 自己用 CLI 造的节点**进不了界面内存**（界面在种子之前就加载完了）⇒ 详情框/清单对不上。
 *   ⇒ 运行时从界面自己的树里挑三个**长标题**节点（长标题才做得出"删掉中间一个字"的子序列查询）。
 * ============================================================ */
'use strict';

const PROJ = 'comnet';
const TITLE = '冒烟探针·关联视图内新建的关联笔记';
const NOTE = '- 由「关联信息」编辑条新建\n- **正文按 Markdown 写**，命令内转 HTML 后存盘';

let PICK = [];   // [中心节点, 链接目标兼成员, 参与子序列查询的备用节点]

/** 嵌进渲染层的字面量一律走它（避免手拼引号） */
const j = (v) => JSON.stringify(v);

async function waitFor(ctx, js, tries) {
  let last = '';
  for (let i = 0; i < (tries || 40); i++) {
    last = await ctx.exec(js);
    try { if (JSON.parse(last).ok) return last; } catch (e) { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return last;
}

async function execJson(ctx, js) {
  const raw = await ctx.exec(js);
  try { return JSON.parse(raw); } catch (e) { return { ok: false, text: String(raw).slice(0, 300) }; }
}

/** CLI 读回（JSON）。失败**如实抛出**，不返回空对象假装"没有"—— 空结果与读不到必须可区分 */
function cliJson(ctx, args) {
  const out = ctx.runCli(args);
  try { return JSON.parse(out); }
  catch (e) { throw new Error('CLI 输出不是 JSON（' + args[0] + '）：' + String(out).slice(0, 200)); }
}

/** 挑三个真实节点：按标题长度倒序（长标题才做得出"删中间一个字"的非连续子序列查询） */
async function pickNodes(ctx) {
  const r = await execJson(ctx, `(function () {
    var jm = window.MMApp.getState().jm, all = [];
    (function walk(n) {
      if (!n) return;
      if (n.id && n.id !== 'root' && n.topic) all.push({ id: n.id, topic: n.topic });
      (n.children || []).forEach(walk);
    })(jm.get_node('root'));
    all.sort(function (a, b) { return b.topic.length - a.topic.length; });
    return JSON.stringify({ ok: all.length >= 3, text: JSON.stringify(all.slice(0, 3)) });
  })()`);
  if (!r.ok) return { ok: false, text: '节点不足三个：' + (r.text || '') };
  try {
    const list = JSON.parse(r.text);
    return { ok: true, list: list };
  } catch (e) { return { ok: false, text: '节点清单解析失败：' + r.text }; }
}

module.exports = [
  {
    name: '关联信息编辑条：进关联视图即出现（可见 · 在面板内 · 有出边/入边两组 · 不遮住被框住的节点）',
    run: async (ctx) => {
      const p = await pickNodes(ctx);
      if (!p.ok) return { ok: false, text: p.text };
      PICK = p.list;
      // 两个新通道必须在 preload 上真的暴露出来（加 IPC 的连带项之一）
      const api = await execJson(ctx, `(function () {
        var a = (window.desktop && window.desktop.app) || {};
        return JSON.stringify({ ok: typeof a.unlinkNodes === 'function' && typeof a.assocAdd === 'function' && typeof a.linkNodes === 'function',
          text: 'unlinkNodes=' + typeof a.unlinkNodes + ' assocAdd=' + typeof a.assocAdd + ' linkNodes=' + typeof a.linkNodes });
      })()`);
      if (!api.ok) return { ok: false, text: 'preload 缺通道：' + api.text };
      await ctx.exec('window.MM.showRelated(' + j(PICK[0].id) + '); 1');
      const r = await waitFor(ctx, `(function () {
        var bar = document.getElementById('mm-rel-edit');
        var p = window.MM.fdPanel();
        if (!bar || !p) return JSON.stringify({ ok: false, text: '还没有 #mm-rel-edit' });
        var br = bar.getBoundingClientRect(), pr = p.getBoundingClientRect();
        if (br.width < 2 || br.height < 2) return JSON.stringify({ ok: false, text: '编辑条没有面积' });
        var inPanel = br.left >= pr.left - 2 && br.right <= pr.right + 2 && br.top >= pr.top - 2 && br.bottom <= pr.bottom + 2;
        var groups = Array.prototype.slice.call(bar.querySelectorAll('.rele-group-title')).map(function (e) { return e.textContent; }).join('｜');
        var title = (bar.querySelector('.rele-title') || {}).textContent || '';
        // **不遮住被框住的节点**：关联视图把节点缩放到"刚好框住"，编辑条占了顶部一条，
        // fit 必须让出它的高度（fitToNodes 的 insetTop）—— 判据是几何，不是"看着没问题"。
        var hits = Array.prototype.slice.call(document.querySelectorAll('jmnode.mm-rel-hit'));
        var minTop = Infinity;
        hits.forEach(function (el) { var q = el.getBoundingClientRect(); minTop = Math.min(minTop, q.top); });
        var clear = !hits.length || !isFinite(minTop) || minTop >= br.bottom - 2;
        return JSON.stringify({
          ok: inPanel && !!bar.querySelector('.rele-add') && !!bar.querySelector('.rele-new')
            && groups.indexOf('出边') >= 0 && groups.indexOf('入边') >= 0 && title.indexOf('关联信息') >= 0 && clear,
          text: '尺寸=' + Math.round(br.width) + 'x' + Math.round(br.height) + ' 在面板内=' + inPanel
            + ' 组=' + groups + ' 标题=' + title + ' 节点数=' + hits.length
            + ' 最高节点=' + (isFinite(minTop) ? Math.round(minTop) : '—') + ' 条底=' + Math.round(br.bottom) + ' 不遮挡=' + clear
        });
      })()`);
      const o = JSON.parse(r);
      return { ok: !!o.ok, text: r };
    }
  },
  {
    name: '关联信息编辑条：「➕ 添加链接」输入即搜 —— **非连续子序列**也能命中（证明用的是共享模糊排序）',
    run: async (ctx) => {
      const target = PICK[1];
      const t = String(target.topic);
      // 删掉中间一个字 ⇒ 这个查询**不是**它的子串（等值/子串匹配必然落空），
      // 但作为子序列它高度吻合 ⇒ 共享的 rankPalette 必须把它排进候选（前 8）。
      const q = t.slice(0, 1) + t.slice(2);
      await ctx.exec('document.querySelector("#mm-rel-edit .rele-add").click(); 1');
      const opened = await waitFor(ctx, `(function () {
        var i = document.querySelector('#mm-rel-edit .rele-q');
        return JSON.stringify({ ok: !!i, text: i ? '搜索框已出现' : '还没有 .rele-q' });
      })()`);
      const o0 = JSON.parse(opened);
      if (!o0.ok) return { ok: false, text: o0.text };
      const r = await waitFor(ctx, `(function () {
        var i = document.querySelector('#mm-rel-edit .rele-q');
        if (!i) return JSON.stringify({ ok: false, text: '没有 .rele-q' });
        if (i.value !== ${j(q)}) { i.value = ${j(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); }
        var rows = Array.prototype.slice.call(document.querySelectorAll('#mm-rel-edit .rele-cand[data-id]'));
        var ids = rows.map(function (x) { return x.getAttribute('data-id'); });
        return JSON.stringify({
          ok: ids.indexOf(${j(target.id)}) >= 0,
          text: '查询=' + ${j(q)} + '（原题「' + ${j(t)} + '」少一个字，非子串）候选=' + ids.slice(0, 4).join(',') + ' 命中=' + (ids.indexOf(${j(target.id)}) >= 0)
        });
      })()`);
      const o = JSON.parse(r);
      return { ok: !!o.ok, text: o.text };
    }
  },
  {
    name: '关联信息编辑条：点候选 ⇒ 建立链接（**界面侧 + 数据侧**都变，内存树同步）',
    run: async (ctx) => {
      const from = PICK[0].id;
      const to = PICK[1].id;
      // 点那个候选（用快照里那一行的下标点，避免重绘后找不到）
      const clicked = await execJson(ctx, `(function () {
        var row = document.querySelector('#mm-rel-edit .rele-cand[data-id="' + ${j(to)} + '"]');
        if (!row) return JSON.stringify({ ok: false, text: '候选里没有目标行' });
        row.click();
        return JSON.stringify({ ok: true, text: '已点击候选 ' + ${j(to)} });
      })()`);
      if (!clicked.ok) return { ok: false, text: clicked.text };
      const r = await waitFor(ctx, `(function () {
        var bar = document.getElementById('mm-rel-edit');
        if (!bar) return JSON.stringify({ ok: false, text: '编辑条不见了' });
        var rows = Array.prototype.slice.call(bar.querySelectorAll('.rele-link[data-dir="out"]'));
        var want = ${j(PROJ + '/' + to)};
        var hit = rows.filter(function (x) {
          var l = x.querySelector('.rele-link-label');
          return l && (l.getAttribute('title') || '') === want;
        });
        var jm = window.MMApp.getState().jm, n = jm.get_node(${j(from)});
        var mem = ((n && n.data && n.data.links) || []).filter(function (l) { return l && l.id === ${j(to)}; });
        return JSON.stringify({
          ok: hit.length === 1 && mem.length === 1,
          text: '界面出边行=' + hit.length + ' 内存 links 命中=' + mem.length + '（共 ' + rows.length + ' 行出边）'
        });
      })()`);
      const o = JSON.parse(r);
      // 数据侧：CLI 读回（磁盘）
      let disk = null;
      try {
        const linksOut = cliJson(ctx, ['links', PROJ, '--json']);
        disk = (linksOut.links || []).filter((l) => l && l.node === from && l.id === to && l.project === PROJ);
      } catch (e) { return { ok: false, text: o.text + ' ｜ 数据侧读回失败：' + ((e && e.message) || e) }; }
      return { ok: !!o.ok && disk.length === 1, text: o.text + ' ｜ 数据侧（CLI links --json）命中=' + disk.length };
    }
  },
  {
    name: '关联信息编辑条：点该行 ✕ ⇒ 删链接**自证**（CLI 读回没了）+ **自清**（内存树里也没了）',
    run: async (ctx) => {
      const from = PICK[0].id;
      const to = PICK[1].id;
      const clicked = await execJson(ctx, `(function () {
        var want = ${j(PROJ + '/' + to)};
        var rows = Array.prototype.slice.call(document.querySelectorAll('#mm-rel-edit .rele-link[data-dir="out"]'));
        for (var i = 0; i < rows.length; i++) {
          var l = rows[i].querySelector('.rele-link-label');
          if (l && (l.getAttribute('title') || '') === want) {
            rows[i].querySelector('.rele-del').click();
            return JSON.stringify({ ok: true, text: '已点第 ' + i + ' 行的 ✕' });
          }
        }
        return JSON.stringify({ ok: false, text: '清单里没有这条出边（前一条断言没建成？）' });
      })()`);
      if (!clicked.ok) return { ok: false, text: clicked.text };
      const r = await waitFor(ctx, `(function () {
        var bar = document.getElementById('mm-rel-edit');
        if (!bar) return JSON.stringify({ ok: false, text: '编辑条不见了' });
        var want = ${j(PROJ + '/' + to)};
        var rows = Array.prototype.slice.call(bar.querySelectorAll('.rele-link'));
        var still = rows.filter(function (x) {
          var l = x.querySelector('.rele-link-label');
          return l && (l.getAttribute('title') || '') === want;
        });
        var jm = window.MMApp.getState().jm, n = jm.get_node(${j(from)});
        var mem = ((n && n.data && n.data.links) || []).filter(function (l) { return l && l.id === ${j(to)}; });
        return JSON.stringify({
          ok: still.length === 0 && mem.length === 0,
          text: '清单里残留=' + still.length + ' 内存 links 残留=' + mem.length
        });
      })()`);
      const o = JSON.parse(r);
      let disk = null;
      try {
        const linksOut = cliJson(ctx, ['links', PROJ, '--json']);
        disk = (linksOut.links || []).filter((l) => l && l.node === from && l.id === to);
      } catch (e) { return { ok: false, text: o.text + ' ｜ 自证读回失败：' + ((e && e.message) || e) }; }
      return { ok: !!o.ok && disk.length === 0, text: o.text + ' ｜ 自证（CLI links --json 残留）=' + disk.length };
    }
  },
  {
    name: '关联信息编辑条：「📝 新建关联笔记」中心节点已预置 / 单成员不能提交 / 加一个成员后提交 ⇒ CLI 与「关联笔记（N）」两侧都有',
    run: async (ctx) => {
      const center = PICK[0];
      const member = PICK[1];
      await ctx.exec('document.querySelector("#mm-rel-edit .rele-new").click(); 1');
      // ① 预置与"至少再加一个"：成员只有中心节点 ⇒ 提交按钮必须是禁用态
      //    （点击处理是异步的（要拉节点清单）⇒ 必须**轮询等面板出来**，不能点完立刻查）
      const preRaw = await waitFor(ctx, `(function () {
        var bar = document.getElementById('mm-rel-edit');
        var submit = bar ? bar.querySelector('.rele-submit') : null;
        if (!submit) return JSON.stringify({ ok: false, text: '还没有 .rele-submit（面板没展开）' });
        var chips = Array.prototype.slice.call(bar.querySelectorAll('.rele-chip'));
        var centerChip = bar.querySelector('.rele-chip--center');
        return JSON.stringify({
          ok: chips.length === 1 && !!centerChip && submit.disabled === true,
          text: '成员数=' + chips.length + ' 有中心节点标签=' + !!centerChip + ' 提交禁用=' + submit.disabled
        });
      })()`);
      const pre = JSON.parse(preRaw);
      if (!pre.ok) return { ok: false, text: '预置/未满 2 个成员时的行为不符：' + pre.text };
      // ② 搜成员并加入。查询用**完整标题**（精确命中 ⇒ 必然在前 8）：
      //    模糊排序那一条能力由断言 2 专门判（这里要的是稳定，不是又一次证明排序）
      const mt = String(member.topic);
      const mq = mt;
      const added = await execJson(ctx, `(function () {
        var i = document.querySelector('#mm-rel-edit .rele-mq');
        if (!i) return JSON.stringify({ ok: false, text: '没有 .rele-mq' });
        i.value = ${j(mq)}; i.dispatchEvent(new Event('input', { bubbles: true }));
        return JSON.stringify({ ok: true, text: '已输入成员查询 ' + ${j(mq)} });
      })()`);
      if (!added.ok) return { ok: false, text: added.text };
      const cand = await waitFor(ctx, `(function () {
        var row = document.querySelector('#mm-rel-edit .rele-cand[data-mid="' + ${j(member.id)} + '"]');
        return JSON.stringify({ ok: !!row, text: row ? '候选里有目标成员' : '候选里没有目标成员（查询=' + ${j(mq)} + '）' });
      })()`);
      const oc = JSON.parse(cand);
      if (!oc.ok) return { ok: false, text: oc.text };
      const r2 = await waitFor(ctx, `(function () {
        // ⚠️ 点击处理是**异步**的（要先 await 一遍节点清单再重绘）⇒ 点完不能立刻查 DOM，
        //    必须轮询（本断言第一版就是这么红的：同一 tick 里读到的还是旧 DOM，成员数=1 ✗）
        var bar = document.getElementById('mm-rel-edit');
        var chips = Array.prototype.slice.call(bar.querySelectorAll('.rele-chip'));
        var submit = bar.querySelector('.rele-submit');
        if (!submit) return JSON.stringify({ ok: false, text: '没有 .rele-submit' });
        if (chips.length < 2 || submit.disabled) {
          var row = bar.querySelector('.rele-cand[data-mid="' + ${j(member.id)} + '"]');
          if (row) row.click();          // 幂等：重绘后这一行会消失（已被选为成员），事件也只生效一次
          return JSON.stringify({ ok: false, text: '等重绘：成员数=' + chips.length + ' 提交可用=' + !submit.disabled });
        }
        return JSON.stringify({ ok: true, text: '成员数=' + chips.length + ' 提交可用=' + !submit.disabled });
      })()`);
      const o2 = JSON.parse(r2);
      if (!o2.ok) return { ok: false, text: '加成员后仍不能提交：' + o2.text };
      // ③ 标题 + 正文（Markdown）⇒ 提交
      await ctx.exec(`(function () {
        var t = document.querySelector('#mm-rel-edit .rele-title');
        var n = document.querySelector('#mm-rel-edit .rele-note');
        t.value = ${j(TITLE)}; t.dispatchEvent(new Event('input', { bubbles: true }));
        n.value = ${j(NOTE)}; n.dispatchEvent(new Event('input', { bubbles: true }));
        return 1;
      })()`);
      await ctx.exec('document.querySelector("#mm-rel-edit .rele-submit").click(); 1');
      // ④ 数据侧：CLI 读回（用写前 id 集合的差集？不必 —— 直接按"成员含中心节点 且 标题是探针标题"认）
      const chk = await waitFor(ctx, `(function () {
        var st = window.MMApp.getState();
        var hit = (st.assoc || []).filter(function (a) {
          return a && a.title === ${j(TITLE)} && (a.members || []).some(function (m) { return m && m.id === ${j(center.id)}; });
        });
        return JSON.stringify({ ok: hit.length === 1, text: '内存 state.assoc 命中=' + hit.length + '（共 ' + (st.assoc || []).length + ' 篇）' });
      })()`);
      const o4 = JSON.parse(chk);
      let disk = [];
      try {
        const raw = cliJson(ctx, ['assoc-list', PROJ, '--json', '--raw']);
        disk = (raw.raw || []).filter((a) => a && a.title === TITLE
          && (a.members || []).some((m) => m && m.id === center.id)
          && (a.members || []).some((m) => m && m.id === member.id));
      } catch (e) { return { ok: false, text: o4.text + ' ｜ 数据侧读回失败：' + ((e && e.message) || e) }; }
      // ⑤ 界面侧：「关联笔记（N）」清单里出现它（打开中心节点的详情框 → 等 .fd-assoc 渲染完）
      await ctx.exec(`(function () {
        var jm = window.MMApp.getState().jm, n = jm.get_node(${j(center.id)});
        if (n) window.MMApp.showDetail(n);
        return 1;
      })()`);
      const entry = await waitFor(ctx, `(function () {
        var rows = Array.prototype.slice.call(document.querySelectorAll('.float-detail .fd-assoc .assoc-entry'));
        var hit = rows.filter(function (r) { return (r.textContent || '').indexOf(${j(TITLE)}) >= 0; });
        return JSON.stringify({
          ok: hit.length === 1,
          text: '「关联笔记」条目共 ' + rows.length + ' 条，含探针标题=' + hit.length
        });
      })()`);
      const o5 = JSON.parse(entry);
      return {
        ok: o4.ok && disk.length === 1 && o5.ok,
        text: '预置/禁用 ✓ ' + o2.text + ' ｜ ' + o4.text + ' ｜ 数据侧（CLI assoc-list --raw）命中=' + disk.length + ' ｜ ' + o5.text
      };
    }
  },
  {
    name: '关联信息编辑条：Esc 退出 ⇒ 编辑条与高亮/线一起收干净（不给后面的域留脏状态）',
    run: async (ctx) => {
      await ctx.exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1");
      const r = await execJson(ctx, `(function () {
        var bar = document.getElementById('mm-rel-edit');
        var host = document.getElementById('mindmap-container');
        var hits = document.querySelectorAll('jmnode.mm-rel-hit').length;
        var svg = document.querySelector('#mm-rel-layer');
        return JSON.stringify({
          ok: !bar && !(host && host.classList.contains('mm-rele-open')) && hits === 0
            && (!svg || Number(svg.dataset.count) === 0) && window.MM.isRelatedEditBarOpen() === false,
          text: '编辑条=' + (bar ? '还在' : '已移除') + ' 容器类=' + (host ? host.classList.contains('mm-rele-open') : '?')
            + ' 高亮=' + hits + ' 线=' + (svg ? svg.dataset.count : '无')
        });
      })()`);
      // 收尾自清：把本域造的东西从沙箱副本里删掉（**自己造的自己收拾**；删不掉也如实说）
      let clean = '';
      try {
        const raw = cliJson(ctx, ['assoc-list', PROJ, '--json', '--raw']);
        const mine = (raw.raw || []).filter((a) => a && a.title === TITLE);
        mine.forEach((a) => { ctx.runCli(['assoc-remove', PROJ, a.id]); clean += 'assoc-remove ' + a.id + ' ✓ '; });
      } catch (e) { clean += '（关联笔记清理没做：' + ((e && e.message) || e).toString().slice(0, 80) + '）'; }
      try {
        ctx.runCli(['unlink', PROJ, PICK[0].id, '--to', PROJ, '--id', PICK[1].id]);
        clean += 'unlink ✓ ';
      } catch (e) {
        clean += '（unlink 未执行：断言 4 已经删掉了那条边 —— 属预期，不算失败）';
      }
      await ctx.exec(`(function () {
        if (window.MMApp && window.MMApp.closeAllFloatDetail) window.MMApp.closeAllFloatDetail();
        return 1;
      })()`);
      return { ok: !!r.ok, text: r.text + ' ｜ 收尾：' + clean };
    }
  }
];
