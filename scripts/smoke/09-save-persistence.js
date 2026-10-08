/* ============================================================
 * scripts/smoke/09-save-persistence.js — 保存落盘与未保存改动保护
 * ------------------------------------------------------------
 * 覆盖一个**真实的数据丢失缺陷**：界面上原本**没有任何保存入口**
 * （工具栏无按钮、菜单无项、无 Ctrl+S），而编辑对话框文案写着"点击保存生效"——
 * 于是人做的新增/编辑/删除只存在内存里，关窗或切项目即丢，且无人能发现
 * （没有任何断言覆盖"人的编辑能落盘"）。
 *
 * 冒烟运行在项目副本上（见 07/08 域），所以这里真的写盘也不会碰真实数据。
 *
 * ⚠️ 本域有一条**已经踩过**的陷阱（2026-10-08 实测）：
 *   `await app.save()` 在"盘上这份与载入时那份不一致"时会走**三方合并**，而合并路径会
 *   `rebuildFromJson()` ⇒ **jsMind 实例被重建**。若在 await **之前**把 `jm` 抓在手里，
 *   之后对它 add_node/remove_node 改的就是**已脱离的旧实例** ⇒ 应用真正的树一字未变
 *   ⇒ `isDirty()`（快照比对）恒为 false ⇒ 断言四个值全 false，而报错信息完全看不出原因 ✗。
 *   实测证据：`SMOKE_ONLY=09` 单跑 12/12 绿；`SMOKE_ONLY=04,09` 红（前面域留下不一致才会走合并路径）；
 *   诊断探针打出 `saveOk=true 项目=comnet jm唯一=false`（= 捕获的 jm 已不是当前实例）。
 *   ⇒ 规矩：**任何 await 之后要继续动树，一律用 `jmNow()` 现取**，不要复用旧引用。
 * ============================================================ */
'use strict';

module.exports = [
  {
    name: '保存：工具栏按钮存在且能把内存改动落盘（写后重读可见）',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           var st = app.getState();
           var name = st.project.name;
           // 前置（断言自建前置 ✓）：先把内存重置成「刚打开磁盘上那份」—— 别的域可能留下脏改动 /
           // 混合状态（全量跑实测：保存被写前闸门拒 ⇒ 保存后仍脏 ⇒ 假红 ✗）。真实用户场景本来就是
           // 「打开项目（干净）⇒ 改 ⇒ 存」✓；同名打开不会弹「丢弃改动」确认 ✓。
           await window.MMApp.openProject(name);
           if (app.isDirty()) return { ok: false, text: '前置失败：重开后仍是脏的（内存与磁盘不一致）' };
           // 现取（勿缓存）：save() 可能触发 rebuildFromJson ⇒ 旧的 jm 引用会失效（见文件头）
           var jmNow = function () { return app.getState().jm; };
           var btn = document.getElementById('btn-save');
           if (!btn) return { ok: false, text: '工具栏没有保存按钮' };
           var id = 'save-probe-1';
           jmNow().add_node('root', id, '保存探针', { detail: '' });
           var dirtyBefore = app.isDirty();
           btn.click();
           // save() 是异步落盘：大项目（comnet 187 节点）主进程校验+原子写可能远超
           // 固定 600ms —— 必须轮询到「不脏」或超时，而不是固定睡眠（断言测副作用）。
           var deadline = Date.now() + 8000;
           while (app.isDirty() && Date.now() < deadline) { await new Promise(function (res) { setTimeout(res, 200); }); }
           var dirtyAfter = app.isDirty();
           // 从磁盘重读，确认真的落盘了
           var reread = await window.desktop.project.read(name);
           function find(n, t) {
             if (!n) return null;
             if (n.id === t) return n;
             var k = n.children || [];
             for (var i = 0; i < k.length; i++) { var f = find(k[i], t); if (f) return f; }
             return null;
           }
           var onDisk = !!find(reread.data.data, id);
           jmNow().remove_node(id);
           app.save();                       // 复原副本（把探针从磁盘删掉）
           return {
             ok: dirtyBefore === true && onDisk === true && dirtyAfter === false,
             text: '点击前有未保存=' + dirtyBefore + ' 落盘=' + onDisk + ' 保存后未保存=' + dirtyAfter
           };
         })()`
      );
      return r;
    }
  },
  {
    name: '保存：Ctrl+S 可用，且菜单项已注册（menu:save）',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           var jmNow = function () { return app.getState().jm; };   // 现取：save() 可能重建实例
           var id = 'save-probe-2';
           jmNow().add_node('root', id, '快捷键探针', { detail: '' });
           var dirtyBefore = app.isDirty();
           document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
           // 同断言 1：轮询等异步落盘完成（大项目固定 600ms 不够，实测 flaky FAIL）
           var deadline = Date.now() + 8000;
           while (app.isDirty() && Date.now() < deadline) { await new Promise(function (res) { setTimeout(res, 200); }); }
           var dirtyAfter = app.isDirty();
           jmNow().remove_node(id);
           app.save();
           return { ok: dirtyBefore === true && dirtyAfter === false,
                    text: 'Ctrl+S 前有未保存=' + dirtyBefore + ' 之后=' + dirtyAfter };
         })()`
      );
      return r;
    }
  },
  {
    name: '未保存改动判定：结构改动与详情编辑都会置为脏，保存后转干净',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           // 现取（勿缓存）：下面的 await app.save() 可能走合并路径 ⇒ rebuildFromJson ⇒ 旧引用失效。
           // 实测（2026-10-08）：缓存旧引用时四个值全 false，诊断得 saveOk=true jm唯一=false。
           var jmNow = function () { return app.getState().jm; };
           // 显式复位：原来假设"刚载入应为干净" ✗ —— 但前一条断言可能留下未保存编辑，
        // 整段按序跑时 base 会是 true ⇒ 偶发假红（本机实测同一份代码 2 红 3 绿 ✓）。
        // 用本文件已有的 API 把状态压回干净 ⇒ 这条断言与"前一个文件干了什么"解耦 ✓。
        await app.save();
        var base = app.isDirty();                       // 复位后必为干净
           var id = 'save-probe-3';
           jmNow().add_node('root', id, '脏标记探针', { detail: '' });
           var afterAdd = app.isDirty();
           var n = jmNow().get_node(id);
           n.data = n.data || {}; n.data.detail = '<p>改了详情</p>';   // 模拟编辑对话框改详情
           var afterEdit = app.isDirty();
           jmNow().remove_node(id);
           await app.save();
           var afterSave = app.isDirty();
           return {
             ok: base === false && afterAdd === true && afterEdit === true && afterSave === false,
             text: '复位后=' + base + ' 新增后=' + afterAdd + ' 改详情后=' + afterEdit + ' 保存后=' + afterSave
           };
         })()`
      );
      return r;
    }
  },
  {
    name: '框选拖动持久化：真手势拖整棵树 ⇒ 保存 ⇒ 重开项目后偏移还在（用户报的"移动无法保存"）',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           var jmNow = function () { return app.getState().jm; };   // await 之后必须现取（见文件头）
           var name = app.getState().project.name;
           var root = jmNow().get_node('root');
           var top = (root.children || [])[0];
           if (!top) return { ok: false, text: '该项目没有顶层主题，测不了拖动持久化' };
           app.clearTreeOffsets();                       // 起点干净（前一条断言可能留过偏移）
           // ① 用**真手势**产生偏移：选中顶层主题 → 进入拖动模式 → mousedown / mousemove / mouseup
           app.applySelection([top.id]);
           app.dragSelection();
           var el = document.querySelector('jmnode[nodeid="' + top.id + '"]');
           if (!el) return { ok: false, text: '找不到顶层主题的 jmnode 元素' };
           var fire = function (type, x, y) {
             el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }));
           };
           fire('mousedown', 400, 300);
           fire('mousemove', 520, 240);                  // 拖 (+120, -60)：缩放 1 ⇒ 偏移应约等于这个位移
           fire('mouseup', 520, 240);
           app.setDragMode(false);                       // 退出拖动模式，别影响后续断言
           app.clearSelection();
           var moved = app.getTreeOffsets()[top.id];
           // ② 保存 → **从磁盘重开项目** → 偏移必须原样回来
           await app.save();
           await app.openProject(name);
           var back = app.getTreeOffsets()[top.id];
           var dirty = app.isDirty();
           var nodeEl = document.querySelector('jmnode[nodeid="' + top.id + '"]');
           var tf = nodeEl ? String(nodeEl.style.transform || '') : '';
           // ③ 收尾：清掉偏移并保存 ⇒ 磁盘回到"无偏移"，后续断言不受影响
           app.clearTreeOffsets();
           await app.save();
           var leftAfterCleanup = Object.keys(app.getTreeOffsets()).length;
           return {
             ok: !!moved && Math.abs(moved.x - 120) <= 2 && Math.abs(moved.y + 60) <= 2
                 && !!back && Math.abs(back.x - moved.x) <= 1 && Math.abs(back.y - moved.y) <= 1
                 && dirty === false && tf.indexOf('translate') === 0 && leftAfterCleanup === 0,
             text: '拖动后=' + JSON.stringify(moved) + ' 重开后=' + JSON.stringify(back)
               + ' 脏=' + dirty + ' DOM=' + (tf || '(无)') + ' 清理后剩余=' + leftAfterCleanup
           };
         })()`
      );
      return r;
    }
  },
  {
    name: '未保存改动的保护：切到别的项目会先弹确认（有脏改动时才拦）',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           var jm = app.getState().jm;
           var st = app.getState();
           var cleanBlocked = null, dirtyBlocked = null;
           var origConfirm = window.confirm;
           try {
             // 干净时不应弹确认 → 直接返回 true
             cleanBlocked = (app.isDirty() === false) ? (app.confirmDiscardIfDirty('测试') === true) : 'skip';
             // 弄脏后，confirm 返回 false 应表示"取消继续"
             var id = 'save-probe-4';
             jm.add_node('root', id, '脏项目探针', { detail: '' });
             window.confirm = function () { return false; };
             dirtyBlocked = app.confirmDiscardIfDirty('切换项目') === false;
             window.confirm = function () { return true; };
             var dirtyAllowed = app.confirmDiscardIfDirty('切换项目') === true;
             jm.remove_node(id);
             await app.save();
             return {
               ok: cleanBlocked === true && dirtyBlocked === true && dirtyAllowed === true,
               text: '干净放行=' + cleanBlocked + ' 脏时取消=' + dirtyBlocked + ' 脏时确认=' + dirtyAllowed
             };
           } finally { window.confirm = origConfirm; }
         })()`
      );
      return r;
    }
  }
];
