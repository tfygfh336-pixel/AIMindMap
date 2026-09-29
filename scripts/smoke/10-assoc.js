/* ============================================================
 * scripts/smoke/10-assoc.js — 「关联笔记」二级页面与数据存活
 * ------------------------------------------------------------
 * 覆盖四件事，其中第三件是最要紧的**数据安全**回归：
 *   1) 二级页面确实是"复用详情框组件"——拖动/改大小/📌/🖥 全都在
 *   2) 它只能从「相关知识点」区的关联入口进入（不是节点、不在树里）
 *   3) **界面保存不会抹掉关联笔记**：assoc 是项目级集合、不属于节点树，
 *      若 serializeTree 忘了带它，界面每次保存都会把它从盘上删掉
 *      （同一类缺陷本工程已犯过：meta.author 被硬编码成空串写回）
 *   4) **界面删被关联引用的节点**会先确认并同步剪掉成员 —— 否则落盘数据带悬挂成员，
 *      保存闸门会拒绝**此后所有**保存，而界面没有改成员的入口（用户被卡死）
 *
 * 数据来源：关联**没有界面创建入口**（设计如此：它由 AI/CLI 写入，界面只负责展示与编辑）。
 * 故本域先用 ctx.runCli 在**冒烟沙箱副本**里造一篇关联笔记，再验证界面。
 * ctx.runCli 走的是同一个 runCli，已被 AI_MINDMAP_PROJECTS_DIR 指向沙箱 —— 不碰真实数据。
 * ============================================================ */
'use strict';

const PROJ = 'comnet';
const A1 = 'tcp-handshake';
const A2 = 'tcp-reliable';
const TITLE = '冒烟探针：三次握手与可靠传输';
/** 第二篇探针：**故意不含 A1**，用来验证"打开 A1 详情"不会用子集覆盖全量集合 */
const TITLE2 = '冒烟探针二：不引用握手节点';

/** 造数据：在沙箱副本里新增两篇关联笔记 */
function seed(ctx) {
  try {
    ctx.runCli(['assoc-add', PROJ, '--members', A1 + ',' + A2, '--title', TITLE, '--note-md', '**先建连**，再在其上做可靠传输。']);
    // 第二篇不含 A1 —— 这样"查看 A1 详情"拿到的子集 ≠ 全量，才能暴露"子集覆盖全量"的缺陷
    ctx.runCli(['assoc-add', PROJ, '--members', A2 + ',dns', '--title', TITLE2, '--note-md', '第二篇探针，用于验证子集同步不会覆盖全量。']);
    return true;
  } catch (e) {
    return false;
  }
}

/** 轮询等待某条件成立（渲染有异步 IPC） */
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
    name: '关联笔记：节点详情的「相关知识点」区出现关联入口（这是二级页面唯一入口）',
    run: async (ctx) => {
      const seeded = seed(ctx);
      if (!seeded) return { ok: false, text: 'seed 失败：assoc-add 未能写入沙箱副本' };
      // 选中成员节点 → 等关联入口出现
      await ctx.exec(
        `(function () {
           var app = window.MMApp;
           var jm = app.getState().jm;
           var n = jm.get_node(${JSON.stringify(A1)});
           if (n) app.showDetail(n);
           return 1;
         })()`
      );
      const chk = await waitFor(ctx, `(function () {
        var el = document.querySelector('.float-detail .fd-assoc');
        if (!el) return JSON.stringify({ ok: false, text: 'no .fd-assoc container' });
        var rows = el.querySelectorAll('.assoc-entry');
        return JSON.stringify({
          ok: rows.length > 0 && el.textContent.indexOf(${JSON.stringify(TITLE)}) >= 0,
          text: '入口数=' + rows.length + ' 含标题=' + (el.textContent.indexOf(${JSON.stringify(TITLE)}) >= 0)
        });
      })()`);
      let ok = false, detail = chk;
      try { const o = JSON.parse(chk); ok = o.ok; detail = o.text; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    name: '关联笔记：点入口打开二级页面（kind=assoc），标题与笔记正文按 HTML 渲染',
    run: async (ctx) => {
      // 打开二级页面并验证内容。
      // **必须锚定本域自己造的那篇探针笔记（TITLE）**，不能盲取"第一个入口"：
      // 真实项目里可能已经有 AI/用户写的关联笔记（本轮就给 comnet 建了 5 篇），
      // 而它们的成员数各不相同 —— 盲取第一个会让断言随真实内容变化而假失败（实测）。
      const chk = await ctx.exec(
        `(function () {
           var app = window.MMApp;
           var rows = document.querySelectorAll('.float-detail .fd-assoc .assoc-entry');
           var row = null;
           rows.forEach(function (el) { if (el.textContent.indexOf(${JSON.stringify(TITLE)}) >= 0) row = el; });
           if (!row) return JSON.stringify({ ok: false, text: '没有找到探针关联入口（共 ' + rows.length + ' 个）' });
           row.click();
           var st = app.getFloatDetailState();
           // 找到 assoc 类型的框
           var found = null;
           for (var i = 0; i < (st.boxes || 0); i++) {
             var b = app.getFloatDetailState(i);
             if (b.kind === 'assoc' && b.visible) found = b;
           }
           if (!found) return JSON.stringify({ ok: false, text: '没有可见的 assoc 框，kinds=' + JSON.stringify(st.kinds) });
           // 取该框的 DOM 内容（同样按 TITLE 定位）
           var boxes = document.querySelectorAll('.float-detail');
           var box = null;
           boxes.forEach(function (el) { if (el.querySelector('.fd-title') && el.querySelector('.fd-title').textContent.indexOf('关联笔记：' + ${JSON.stringify(TITLE)}) === 0) box = el; });
           if (!box) return JSON.stringify({ ok: false, text: '未找到标题以「关联笔记：探针」开头的框' });
           var title = box.querySelector('.fd-title').textContent;
           var note = box.querySelector('.fd-detail-content');
           var members = box.querySelectorAll('.fd-related .bl-item').length;
           return JSON.stringify({
             ok: title.indexOf(${JSON.stringify(TITLE)}) >= 0
                 && !!note.querySelector('strong')          // Markdown 已由 CLI 转成 HTML
                 && members === 2,                          // 本域 seed 的就是 2 个成员
             text: '标题=' + title + ' 笔记含<strong>=' + !!note.querySelector('strong')
                 + ' 成员数=' + members + ' kind=' + found.kind
           });
         })()`
      );
      let ok = false, detail = chk;
      try { const o = JSON.parse(chk); ok = o.ok; detail = o.text; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    // 【数据安全回归】两条实测过的丢数据路径，都在"界面保存把内存那份 assoc 写回"上：
    //   ① 详情框取 assoc 用的是 `assoc-list --node <当前节点>` —— **该节点的子集**。
    //      渲染层若拿子集整体替换内存，看一次节点详情就会把别的笔记挤出内存，
    //      随后保存即从磁盘删掉它们（实测 7 篇 → 5 篇）。
    //   ② AI/CLI 在界面打开期间新写的笔记，渲染层内存里根本没有 —— 保存时同样会被抹掉。
    name: '【数据安全】查看节点详情不丢别的关联笔记（子集不覆盖全量；外部新写的也不被保存抹掉）',
    run: async (ctx) => {
      // 两步走，否则测不到：A2 同属两篇探针（先看它，内存里才有两篇），
      // 而 A1 只属第一篇 —— 再看 A1 时"该节点的子集"才 ≠ 内存里的集合。
      const showAndWait = async (nodeId) => {
        await ctx.exec(
          `(function () {
             var app = window.MMApp;
             var n = app.getState().jm.get_node(${JSON.stringify(nodeId)});
             if (n) app.showDetail(n);
             return 1;
           })()`
        );
        for (let i = 0; i < 30; i++) {
          const ready = await ctx.exec(`document.querySelectorAll('.float-detail .fd-assoc .assoc-entry').length > 0`);
          if (ready) break;
          await new Promise((r) => setTimeout(r, 200));
        }
      };
      const titlesJs = `(window.MMApp.getState().assoc || []).map(function (a) { return a && a.title; })`;

      await showAndWait(A2);
      let a2Info = '';
      try {
        const p = JSON.parse(await ctx.exec(
          `(function () { var t = ${titlesJs};
             return JSON.stringify({ n: t.length, has2: t.indexOf(${JSON.stringify(TITLE2)}) >= 0 }); })()`
        ));
        a2Info = '看完 A2 后内存篇数=' + p.n + ' 含第二篇=' + p.has2;
      } catch (e) { a2Info = 'A2 步骤读取失败'; }

      await showAndWait(A1);                       // 关键一步：A1 的子集不含第二篇
      const chk = await ctx.exec(
        `(function () { var t = ${titlesJs};
           return JSON.stringify({
             ok: t.indexOf(${JSON.stringify(TITLE)}) >= 0 && t.indexOf(${JSON.stringify(TITLE2)}) >= 0,
             text: '看完 A1 后内存篇数=' + t.length
                 + ' 含第一篇=' + (t.indexOf(${JSON.stringify(TITLE)}) >= 0)
                 + ' 含第二篇（不含 A1 的那篇）=' + (t.indexOf(${JSON.stringify(TITLE2)}) >= 0)
           }); })()`
      );
      let memOk = false, detail = chk;
      try { const o = JSON.parse(chk); memOk = o.ok; detail = o.text; } catch (e) { detail = chk; }

      // 再真正保存一次，从磁盘确认两篇都还在（内存对了但写盘丢了一样是数据丢失）
      await ctx.exec('window.MMApp.save()');
      await new Promise((r) => setTimeout(r, 900));
      let diskOk = false, diskInfo = '';
      try {
        const j = JSON.parse(ctx.runCli(['assoc-list', PROJ, '--json']));
        const titles = (j.items || []).map((x) => x && x.title);
        diskOk = titles.indexOf(TITLE) >= 0 && titles.indexOf(TITLE2) >= 0;
        diskInfo = '保存后磁盘篇数=' + titles.length;
      } catch (e) { diskInfo = '读取失败: ' + (e && e.message); }

      return { ok: memOk && diskOk, text: a2Info + ' | ' + detail + ' | ' + diskInfo + ' 两篇都在=' + diskOk };
    }
  },
  {
    name: '关联笔记：二级页面与节点详情同款特性（可拖动/改大小把手/📌/🖥 齐备）',
    run: async (ctx) => {
      const chk = await ctx.exec(
        `(function () {
           var boxes = document.querySelectorAll('.float-detail');
           var box = null;
           boxes.forEach(function (el) {
             var t = el.querySelector('.fd-title');
             if (t && t.textContent.indexOf('关联笔记：' + ${JSON.stringify(TITLE)}) === 0) box = el;
           });
           if (!box) return JSON.stringify({ ok: false, text: '没有二级页面的框' });
           var handles = box.querySelectorAll('.fd-rs').length;
           var lockMap = box.querySelectorAll('.fd-lock-map').length;
           var lockScreen = box.querySelectorAll('.fd-lock-screen').length;
           var draggableHead = !!box.querySelector('.fd-head');
           return JSON.stringify({
             ok: handles === 8 && lockMap === 1 && lockScreen === 1 && draggableHead,
             text: '改大小把手=' + handles + ' 小锁=' + lockMap + ' 大锁=' + lockScreen + ' 标题栏=' + draggableHead
           });
         })()`
      );
      let ok = false, detail = chk;
      try { const o = JSON.parse(chk); ok = o.ok; detail = o.text; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    name: '关联笔记：可上锁（大锁后大小与位置冻结）—— 与节点详情同一套机制',
    run: async (ctx) => {
      const chk = await ctx.exec(
        `(function () {
           var app = window.MMApp;
           var boxes = document.querySelectorAll('.float-detail');
           var box = null;
           boxes.forEach(function (el) {
             var t = el.querySelector('.fd-title');
             if (t && t.textContent.indexOf('关联笔记：' + ${JSON.stringify(TITLE)}) === 0) box = el;
           });
           if (!box) return JSON.stringify({ ok: false, text: '没有二级页面的框' });
           box.querySelector('.fd-lock-screen').click();
           var st = app.getFloatDetailState();
           var mine = null;
           for (var i = 0; i < st.boxes; i++) { var b = app.getFloatDetailState(i); if (b.kind === 'assoc') mine = b; }
           var geo = { left: box.style.left, top: box.style.top };
           app.setViewScale(1.6);
           var after = { left: box.style.left, top: box.style.top };
           var frozen = geo.left === after.left && geo.top === after.top;
           box.querySelector('.fd-lock-screen').click();   // 解锁，免影响后续
           app.setViewScale(1);
           return JSON.stringify({
             ok: !!mine && mine.lock === 'screen' && frozen,
             text: 'lock=' + (mine && mine.lock) + ' 缩放前后位置一致=' + frozen
           });
         })()`
      );
      let ok = false, detail = chk;
      try { const o = JSON.parse(chk); ok = o.ok; detail = o.text; } catch (e) { detail = chk; }
      return { ok, text: detail };
    }
  },
  {
    name: '【数据安全】界面保存不会抹掉关联笔记（assoc 不属于节点树，必须被 serializeTree 带出）',
    run: async (ctx) => {
      // 关键回归：先确认盘上有 assoc，再触发一次界面保存，最后从盘上重新读回。
      // 若 serializeTree 漏掉 assoc，这一步会把它删掉 —— 而且是**静默**删掉。
      const before = ctx.runCli(['assoc-list', PROJ, '--json']);
      let beforeCount = -1;
      try { beforeCount = JSON.parse(before).count; } catch (e) { /* 交给断言失败 */ }

      await ctx.exec('window.MMApp.save()');
      await new Promise((r) => setTimeout(r, 700));

      const after = ctx.runCli(['assoc-list', PROJ, '--json']);
      let afterCount = -1, hasNote = false;
      try {
        const j = JSON.parse(after);
        afterCount = j.count;
        hasNote = !!(j.items[0] && j.items[0].hasNote);
      } catch (e) { /* 交给断言失败 */ }

      return {
        ok: beforeCount > 0 && afterCount === beforeCount && hasNote,
        text: '保存前=' + beforeCount + ' 保存后=' + afterCount + ' 笔记仍在=' + hasNote
      };
    }
  },
  {
    // 走**真实 UI 路径**（打开二级页面 → 点「编辑笔记」→ 填表 → 保存），
    // 而不是直接调 IPC —— 后者会绕过渲染层的内存同步逻辑，测不到真正的行为。
    name: '关联笔记：页面内编辑经 CLI 落盘（Markdown → HTML），并同步进内存',
    run: async (ctx) => {
      // 1) 打开**探针那篇**的二级页面（按 TITLE 定位入口，不盲取第一个 —— 见首条断言的说明）
      await ctx.exec(
        `(function () {
           var rows = document.querySelectorAll('.float-detail .fd-assoc .assoc-entry');
           var row = null;
           rows.forEach(function (el) { if (el.textContent.indexOf(${JSON.stringify(TITLE)}) >= 0) row = el; });
           if (row) row.click();
           return 1;
         })()`
      );
      await new Promise((r) => setTimeout(r, 400));
      // 2) 点「编辑笔记」→ 填表 → 保存（按钮同样取自探针那个框）
      const opened = await ctx.exec(
        `(function () {
           var boxes = document.querySelectorAll('.float-detail');
           var box = null;
           boxes.forEach(function (el) {
             var t = el.querySelector('.fd-title');
             if (t && t.textContent.indexOf('关联笔记：' + ${JSON.stringify(TITLE)}) === 0) box = el;
           });
           if (!box) return JSON.stringify({ ok: false, text: '没找到探针的二级页面框' });
           var btn = box.querySelector('.assoc-edit-btn');
           if (!btn) return JSON.stringify({ ok: false, text: '二级页面没有「编辑笔记」按钮' });
           btn.click();
           var dlg = document.getElementById('assoc-dialog');
           if (!dlg || dlg.style.display === 'none') return JSON.stringify({ ok: false, text: '编辑对话框未打开' });
           document.getElementById('assoc-title').value = ${JSON.stringify(TITLE)};
           document.getElementById('assoc-note').value = '**改过的**笔记内容';
           document.getElementById('assoc-ok').click();
           return JSON.stringify({ ok: true, text: '已提交保存' });
         })()`
      );
      let openOk = false;
      try { openOk = JSON.parse(opened).ok; } catch (e) { /* 下面统一报 */ }
      if (!openOk) return { ok: false, text: String(opened).slice(0, 160) };

      // 3) 等保存完成（写盘 + 回读 + 同步内存）
      await new Promise((r) => setTimeout(r, 900));
      const chk = await ctx.exec(
        `(function () {
           var app = window.MMApp;
           var st = app.getState();
           var mem = (st.assoc || []).filter(function (a) { return a && a.title === ${JSON.stringify(TITLE)}; })[0];
           var dlg = document.getElementById('assoc-dialog');
           return JSON.stringify({
             ok: !!mem && mem.note.indexOf('<strong>改过的</strong>') >= 0 && (!dlg || dlg.style.display === 'none'),
             text: '内存 note 含<strong>=' + (!!mem && mem.note.indexOf('<strong>改过的</strong>') >= 0)
                 + ' 对话框已关闭=' + (!dlg || dlg.style.display === 'none')
           });
         })()`
      );
      let ok = false, detail = chk;
      try { const o = JSON.parse(chk); ok = o.ok; detail = o.text; } catch (e) { detail = chk; }
      // 4) 磁盘也应是 HTML 形式（同样按 TITLE 找探针那篇，而不是取 items[0]）
      let diskOk = false, diskNote = '';
      try {
        const j = JSON.parse(ctx.runCli(['assoc-list', PROJ, '--json']));
        const probe = (j.items || []).filter((x) => x && x.title === TITLE)[0];
        diskNote = (probe && probe.note) || '';
        diskOk = diskNote.indexOf('<strong>改过的</strong>') >= 0;
      } catch (e) { /* 交给断言失败 */ }
      return { ok: ok && diskOk, text: detail + ' | 磁盘含<strong>=' + diskOk };
    }
  },
  {
    name: '关联笔记：编辑后再保存界面不回退（内存与磁盘一致），且数据里不混入视图派生字段',
    run: async (ctx) => {
      await ctx.exec('window.MMApp.save()');
      await new Promise((r) => setTimeout(r, 800));
      const out = ctx.runCli(['assoc-list', PROJ, '--json', '--raw']);
      let kept = false, clean = false, count = -1, keys = [];
      try {
        const j = JSON.parse(out);
        count = j.count;
        // 按 TITLE 取探针那篇的原始实体（不取 raw[0]：真实项目里可能有别的关联笔记）
        const raw = (j.raw || []).filter((a) => a && a.title === TITLE)[0] || {};
        keys = Object.keys(raw);
        kept = typeof raw.note === 'string' && raw.note.indexOf('改过的') >= 0;
        // 只允许契约字段；effectiveTitle / hasNote / 成员里的 topic/label 都是"视图派生值"，
        // 一旦被写进文件就是数据污染（它们本该只存在于 CLI 的输出里）。
        const allowed = ['id', 'title', 'members', 'note'];
        const extra = keys.filter((k) => allowed.indexOf(k) < 0);
        const memberExtra = ((raw.members || [])[0] ? Object.keys(raw.members[0]) : [])
          .filter((k) => ['project', 'id'].indexOf(k) < 0);
        clean = extra.length === 0 && memberExtra.length === 0;
        if (!clean) keys = keys.concat(memberExtra.map((k) => 'member.' + k));
      } catch (e) { /* 交给断言失败 */ }
      return {
        ok: count > 0 && kept && clean,
        text: '保存后仍含改过的内容=' + kept + ' 关联数=' + count
          + ' 字段干净=' + clean + ' 字段=' + JSON.stringify(keys)
      };
    }
  },
  {
    // 这是 assoc 与节点树**唯一的交叉点**，也是最容易把用户卡死的一条路：
    // 界面上删掉一个被关联引用的节点 → 落盘数据带"悬挂成员" → 保存闸门（CLI validate）拒绝
    // → 而界面没有"改成员"的入口 → 用户无法保存任何改动，只能去命令行自救。
    // 所以必须走**真实 UI 路径**（MM.deleteNode → 确认 → 剪枝 → 保存）验证整条链是通的。
    name: '关联笔记：界面删被引用的节点会先确认、并同步剪掉成员（不留悬挂成员 → 保存不被闸门拒）',
    run: async (ctx) => {
      // 前置：盘上确实有一篇引用 tcp-reliable 的关联（成员恰好 2 个 → 剪掉一个就整篇删除）
      const before = ctx.runCli(['assoc-list', PROJ, '--json', '--node', A2]);
      let beforeCount = -1;
      try { beforeCount = JSON.parse(before).count; } catch (e) { /* 交给断言失败 */ }
      if (beforeCount < 1) return { ok: false, text: '前置失败：没有引用 ' + A2 + ' 的关联（前序断言可能已改动数据）' };

      // 1) 桩掉 window.confirm：既避免冒烟被弹窗卡住，又能断言"确实先问过"
      await ctx.exec(
        `(function () {
           window.__origConfirm = window.confirm;
           window.__confirmMsg = '';
           window.confirm = function (m) { window.__confirmMsg = String(m); return true; };
           return 1;
         })()`
      );
      // 2) 走真实 UI 路径删除（内部会异步读 assoc 再剪枝）
      await ctx.exec('window.MMApp.deleteNode(' + JSON.stringify(A2) + ')');
      let gone = false;
      for (let i = 0; i < 40; i++) {
        gone = await ctx.exec('!window.MMApp.getState().jm.get_node(' + JSON.stringify(A2) + ')');
        if (gone) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      // 3) 取内存与确认文案，然后还原 confirm
      const chk = await ctx.exec(
        `(function () {
           var st = window.MMApp.getState();
           var still = (st.assoc || []).filter(function (a) {
             return (a.members || []).some(function (m) { return m && m.id === ${JSON.stringify(A2)}; });
           }).length;
           var msg = window.__confirmMsg || '';
           window.confirm = window.__origConfirm;
           return JSON.stringify({
             ok: still === 0 && msg.length > 0,
             text: '内存里仍引用被删节点的关联数=' + still + ' 确认文案长度=' + msg.length,
             msg: msg
           });
         })()`
      );
      let memOk = false, detail = chk, msg = '';
      try { const o = JSON.parse(chk); memOk = o.ok; detail = o.text; msg = o.msg || ''; } catch (e) { detail = chk; }
      const askedFirst = msg.indexOf('关联笔记') >= 0 && msg.indexOf('清理') >= 0;

      // 4) 保存：若内存没剪干净，闸门会拒绝（这是"用户被卡死"的复现条件）
      await ctx.exec('window.MMApp.save()');
      await new Promise((r) => setTimeout(r, 900));

      let diskOk = false, dangling = '', count2 = -1;
      try {
        const j = JSON.parse(ctx.runCli(['assoc-list', PROJ, '--json']));
        count2 = j.count;
        const v = ctx.runCli(['validate', PROJ]);
        diskOk = v.indexOf('校验通过') >= 0;
        dangling = (j.items || []).map((it) => it.id).join(',');
      } catch (e) { dangling = '读取失败: ' + (e && e.message); }

      return {
        ok: gone && memOk && askedFirst && diskOk,
        text: '节点已删=' + gone + ' 删除前先确认=' + askedFirst + ' | ' + detail
          + ' | 保存后 validate 通过=' + diskOk + ' 关联数=' + count2
      };
    }
  }
];
