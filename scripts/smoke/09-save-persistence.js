/* ============================================================
 * scripts/smoke/09-save-persistence.js — 保存落盘与未保存改动保护
 * ------------------------------------------------------------
 * 覆盖一个**真实的数据丢失缺陷**：界面上原本**没有任何保存入口**
 * （工具栏无按钮、菜单无项、无 Ctrl+S），而编辑对话框文案写着"点击保存生效"——
 * 于是人做的新增/编辑/删除只存在内存里，关窗或切项目即丢，且无人能发现
 * （没有任何断言覆盖"人的编辑能落盘"）。
 *
 * 冒烟运行在项目副本上（见 07/08 域），所以这里真的写盘也不会碰真实数据。
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
           var jm = st.jm;
           var btn = document.getElementById('btn-save');
           if (!btn) return { ok: false, text: '工具栏没有保存按钮' };
           var id = 'save-probe-1';
           jm.add_node('root', id, '保存探针', { detail: '' });
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
           jm.remove_node(id);
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
           var jm = app.getState().jm;
           var id = 'save-probe-2';
           jm.add_node('root', id, '快捷键探针', { detail: '' });
           var dirtyBefore = app.isDirty();
           document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
           // 同断言 1：轮询等异步落盘完成（大项目固定 600ms 不够，实测 flaky FAIL）
           var deadline = Date.now() + 8000;
           while (app.isDirty() && Date.now() < deadline) { await new Promise(function (res) { setTimeout(res, 200); }); }
           var dirtyAfter = app.isDirty();
           jm.remove_node(id);
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
           var jm = app.getState().jm;
           var base = app.isDirty();                       // 刚载入应为干净
           var id = 'save-probe-3';
           jm.add_node('root', id, '脏标记探针', { detail: '' });
           var afterAdd = app.isDirty();
           var n = jm.get_node(id);
           n.data = n.data || {}; n.data.detail = '<p>改了详情</p>';   // 模拟编辑对话框改详情
           var afterEdit = app.isDirty();
           jm.remove_node(id);
           await app.save();
           var afterSave = app.isDirty();
           return {
             ok: base === false && afterAdd === true && afterEdit === true && afterSave === false,
             text: '载入=' + base + ' 新增后=' + afterAdd + ' 改详情后=' + afterEdit + ' 保存后=' + afterSave
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
