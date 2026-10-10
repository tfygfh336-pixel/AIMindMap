/* ============================================================
 * scripts/smoke/27-import-doc.js — 大文件导入成新项目（功能 5a 的界面入口）
 * ------------------------------------------------------------
 * 覆盖三条：
 *   1) 扩展名判据 + 不支持的格式**响亮说明**（.pdf 等不许静默失败 ✗）
 *   2) **真导入一条链**：写一个探针 md ⇒ `MM.importDocFile(路径)`（拖拽入口用的就是它 ✓）
 *      ⇒ 新项目出现、能被 CLI 读回、并且**界面自动打开它**（主进程发 menu:open-project ✓）
 *   3) 导入失败路径：路径不存在 ⇒ 返回 ok:false 且带原因（不许假装成功 ✓）
 *
 * 数据落在冒烟**沙箱副本**（AI_MINDMAP_PROJECTS_DIR 指向副本 ⇒ 不碰真实 projects/ ✓）。
 * 探针文件由断言自己写在系统临时目录里（Node 侧，不在仓库里留东西 ✓）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

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

/** 写一个探针 md（在系统临时目录，随用随删） */
function writeProbe(name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-imp-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

module.exports = [
  {
    name: '导入：扩展名判据 —— .pdf 已**受支持**（P8 切片：限有书签 ✓），.doc/.epub/.png 仍**响亮说明**',
    run: async (ctx) => {
      const res = await execJson(ctx, `(function () {
        var MM = window.MM;
        var okList = ['.md', '.markdown', '.txt', '.text', '.docx', '.pdf'].map(function (e) { return MM.importExtOk('书' + e); });
        var badList = ['.doc', '.epub', '.png'].map(function (e) { return MM.importExtOk('书' + e); });
        // 喂一个**仍不支持**的 File 形状对象：应当只提示、不发起导入
        MM.importHandleFiles([{ name: '某本书.epub' }]);
        var status = (document.querySelector('#status-text') || {}).textContent || '';
        return JSON.stringify({
          ok: okList.every(Boolean) && badList.every(function (b) { return !b; }) && status.indexOf('暂不支持') >= 0,
          text: '支持的都认=' + okList.every(Boolean) + '（含 .pdf ✓）不支持的都拒=' + badList.every(function (b) { return !b; })
            + ' 状态栏=' + JSON.stringify(status.slice(0, 60))
        });
      })()`);
      return { ok: !!res.ok, text: res.text };
    }
  },
  {
    name: '导入：真导入一条链（探针 md ⇒ 新项目 ⇒ 能读回 ⇒ 界面自动打开它）',
    run: async (ctx) => {
      const file = writeProbe('两本书.md', [
        '# 计算机网络（自顶向下方法）', '', '## 第 1 章 概述', '互联网的组成。', '',
        '# 数据结构与算法', '', '## 第 1 章 绪论', '复杂度分析。', ''
      ].join('\n'));
      const before = await execJson(ctx, `window.desktop.projects().then(function (p) {
        return JSON.stringify({ ok: true, text: '导入前项目数=' + p.length, n: p.length });
      })`);
      // 先把当前项目的未保存改动落盘：`openProject` 对**脏**状态会走既有确认（冒烟里没人点确定 ⇒
      // 合法地不切换）。真实使用者也一样 —— 想让它自动打开新项目，先别留着未保存改动 ✓
      const saved = await execJson(ctx, `(function () {
        if (!window.MMApp || !window.MMApp.save) return JSON.stringify({ ok: false, text: '没有 MMApp.save' });
        return window.MMApp.save().then(function () {
          return JSON.stringify({ ok: true, text: '已保存当前项目' });
        }).catch(function (e) { return JSON.stringify({ ok: false, text: '保存失败：' + (e && e.message) }); });
      })()`);
      // 诊断：记录"事件是否到达渲染层"，并且**由断言自己**再调一次 openProject 并记下返回值 ——
      // 这样能把"事件没到"、"我的监听没跑"、"openProject 自己失败"三种情况分开 ✓
      await ctx.exec(`(function () {
        window.__openEvt = null; window.__openRet = null; window.__seq = [];
        function cur() { var st = window.MMApp.getState(); return (st.project && st.project.name) || '?'; }
        if (window.desktop && window.desktop.on) {
          window.desktop.on('menu:open-project', function (n) {
            window.__openEvt = n;
            window.__seq.push('事件到达 cur=' + cur());
            Promise.resolve(window.MM.openProject(n)).then(function (r) {
              window.__openRet = String(r);
              window.__seq.push('openProject 返回 ' + r + ' cur=' + cur());
              setTimeout(function () { window.__seq.push('1.5s 后 cur=' + cur()); }, 1500);
            }).catch(function (e) {
              window.__openRet = 'ERR:' + ((e && e.message) || e);
              window.__seq.push('openProject 抛错 ' + window.__openRet);
            });
          });
        }
        return 1;
      })()`);
      const res = await execJson(ctx, `window.MM.importDocFile(${JSON.stringify(file)}).then(function (r) {
        return JSON.stringify({ ok: !!r && r.ok === true, text: (r && r.ok) ? ('项目=' + r.name) : ('失败=' + ((r && r.error) || '?')) , name: r && r.name });
      })`);
      if (!res.ok) return { ok: false, text: '导入失败：' + res.text };
      // ① 项目列表里有它 ② CLI 能读回两棵顶层主题 ③ 界面已切到它
      const listed = await execJson(ctx, `window.desktop.projects().then(function (p) {
        var has = p.some(function (x) { return x.name === ${JSON.stringify(res.name)}; });
        return JSON.stringify({ ok: has, text: '导入后项目数=' + p.length + '（' + ${before.n || 0} + ' → ' + p.length + '）含新项目=' + has });
      })`);
      const readBack = ctx.runCli(['read', res.name, '--brief']);
      const hasThemes = /计算机网络（自顶向下方法）/.test(readBack) && /数据结构与算法/.test(readBack);
      const opened = await waitFor(ctx, `(function () {
        var st = window.MMApp.getState();
        var cur = st.project && st.project.name;
        var evt = window.__openEvt;
        var status = (document.querySelector('#status-text') || {}).textContent || '';
        var dirty = !!(window.MMApp.isDirty && window.MMApp.isDirty());
        return JSON.stringify({ ok: cur === ${JSON.stringify(res.name)},
          text: '界面当前项目=' + cur + '（应为 ' + ${JSON.stringify(res.name)} + '）'
            + ' ｜ 事件=' + (evt === null ? '（没到）' : JSON.stringify(evt))
            + ' ｜ 时间线=' + JSON.stringify(window.__seq)
            + ' ｜ 脏=' + dirty + ' ｜ 状态栏=' + JSON.stringify(status.slice(0, 40)) });
      })()`);
      const o = JSON.parse(opened);
      // 收尾：把界面切回原来的项目 —— 本域把 app 切到了新项目，而后面的视觉断言（ROI 截图）
      // 是按"当前项目"取景的 ✗。不留脏状态是本工程对每个冒烟域的要求 ✓
      const back = await execJson(ctx, `(function () {
        var st = window.MMApp.getState();
        var home = ${JSON.stringify('comnet')};
        if (!st.project || st.project.name === home) return JSON.stringify({ ok: true, text: '无需切回' });
        return Promise.resolve(window.MM.openProject(home)).then(function (r) {
          var now = window.MMApp.getState().project.name;
          return JSON.stringify({ ok: now === home, text: '已切回 ' + now });
        });
      })()`);
      return {
        ok: !!saved.ok && !!listed.ok && hasThemes && !!o.ok && !!back.ok,
        text: saved.text + ' ｜ ' + res.text + ' ｜ ' + listed.text + ' ｜ CLI 读回两棵树=' + hasThemes
          + ' ｜ ' + o.text + ' ｜ 收尾=' + back.text
      };
    }
  },
  {
    name: '导入：路径不存在 ⇒ ok:false 且带原因（不许假装成功）',
    run: async (ctx) => {
      const res = await execJson(ctx, `window.MM.importDocFile('Z:\\\\definitely\\\\not\\\\here\\\\x.md').then(function (r) {
        return JSON.stringify({ ok: !r || r.ok === false, text: 'ok=' + (r && r.ok) + ' error=' + ((r && r.error) || '(无)').slice(0, 80) });
      })`);
      const hasErr = /不存在/.test(res.text);
      return { ok: !!res.ok && hasErr, text: res.text };
    }
  },

  {
    // ⚠️ 名字里**不要**出现「可见/看不见/遮挡…」那几个词（V1 门禁会要求真判据）
    name: '导入：来源指纹 origin 记下来了，且**界面保存不会抹掉它**（整树写回是手挑字段，漏一个就静默丢）',
    run: async (ctx) => {
      // 这条冲着一个**真失效模式**来的：`origin` 是"这份文档导过没有"的唯一判据（导入幂等闸门靠它），
      // 而导入走 CLI（外部写盘）、界面保存走 `serializeTree()` 的**手挑字段**整树写回 ——
      // 漏了它就会被静默抹掉 ⇒ 同一份文档又能被导入第二遍，而界面上一切正常 ✗。
      // 与 `qa` / `localPath` 完全同型（那两条各有一个冒烟断言守着，本条是第三个）。
      const file = writeProbe('origin-keep-probe.md', ['# 只此一章', '', '正文。', ''].join('\n'));
      const res = await execJson(ctx, `window.MM.importDocFile(${JSON.stringify(file)}).then(function (r) {
        return JSON.stringify({ ok: !!r && r.ok === true, name: r && r.name,
          text: (r && r.ok) ? ('项目=' + r.name) : ('失败=' + ((r && r.error) || '?')) });
      })`);
      if (!res.ok) return { ok: false, text: '导入失败：' + res.text };
      // ① 导入就该留下指纹（走 CLI 读盘：与界面写的是同一个文件）
      const rootJson = () => {
        try { return JSON.parse(ctx.runCli(['get', res.name, 'root', '--json'])); } catch (e) { return null; }
      };
      const o1 = (rootJson() || {}).origin || null;
      const shapeOk = !!(o1 && o1.kind === 'import' && /^[0-9a-f]{64}$/.test(o1.sha256)
        && /origin-keep-probe\.md$/.test(o1.src) && o1.tool === 'import-project');
      // ② 等界面切到新项目（主进程发 menu:open-project 是异步的），再造改动 + 保存（整树写回）
      let cur = '';
      for (let i = 0; i < 20; i++) {
        cur = await ctx.exec('(window.MMApp.getState().project || {}).name || ""');
        if (cur === res.name) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const saved = await execJson(ctx, `(async function () {
        var app = window.MMApp;
        app.addNode('root');               // 真实改动：否则可能走不到写盘
        // ⚠️ addNode 会**顺手打开**「编辑节点」对话框（app-actions.js:279 的 MMEditor.editNode）——
        //    必须**当场关掉**：本域离开时留一个模态，后面的域（34/36/37 全是真鼠标输入 + elementFromPoint
        //    命中测试）会整片变红。实测：不关它 ⇒ 34/36/37 共 9 条断言变红，报文是
        //    "命中测试命中圆钮=false（命中=overlay）" 与 "编辑框=true"（而这个文件本身**没被改过**）。
        //    这里走**用户关框的那条路**（点「取消」⇒ editor.js 的 closeEditDialog）。冒烟"每域不留脏状态"
        //    的既有要求：离开本域时界面必须回到进入时的样子。
        var dlg = document.getElementById('edit-dialog');
        var cancel = document.getElementById('edit-cancel');
        if (cancel) cancel.click();
        var closedAfterAdd = !dlg || dlg.style.display === 'none';
        var s1 = await app.save();
        app.undo();                        // 撤掉探针改动
        // 再存一次：把"撤掉"也落盘 ⇒ 内存与盘一致、不脏 —— 否则下面切不回原项目。
        //（openProject 对脏状态走的是"问人确认"，冒烟里没人点确定 ⇒ 合法地不切换，
        //  于是**后面的每一个域**都在这个探针项目上跑。实测踩到：22 条断言一起变红 ✗）
        var s2 = await app.save();
        var dlg2 = document.getElementById('edit-dialog');
        return JSON.stringify({ ok: s1 === true && s2 === true && closedAfterAdd,
          text: 'save()=' + s1 + '/' + s2 + ' · 编辑框已关=' + closedAfterAdd
            + '（收尾时仍未关=' + (!dlg2 || dlg2.style.display === 'none' ? false : true) + '）' });
      })()`);
      // ③ 保存之后指纹必须**逐字还在**（这是本条的验收核心）
      const o2 = (rootJson() || {}).origin || null;
      const kept = !!(o1 && o2 && o2.sha256 === o1.sha256 && o2.src === o1.src && o2.at === o1.at);
      // ④ 收尾（**无论成败都要走到**）：切回原项目 + 删掉探针项目。
      //    本工程对每个冒烟域的要求是"不留脏状态"—— 留了就会连环红（见上面那条实测）。
      const back = await execJson(ctx, `(function () {
        var home = ${JSON.stringify('comnet')};
        var st = window.MMApp.getState();
        if (!st.project || st.project.name === home) return JSON.stringify({ ok: true, text: '无需切回' });
        return Promise.resolve(window.MM.openProject(home)).then(function (r) {
          var now = (window.MMApp.getState().project || {}).name;
          return JSON.stringify({ ok: r !== false && now === home, text: '已切回 ' + now + '（openProject=' + r + '）' });
        }).catch(function (e) {
          return JSON.stringify({ ok: false, text: '切回失败：' + ((e && e.message) || e) });
        });
      })()`);
      let cleaned = false;
      try {
        const dir = path.join(process.env.AI_MINDMAP_PROJECTS_DIR || '', res.name);
        fs.rmSync(dir, { recursive: true, force: true });
        cleaned = !fs.existsSync(dir);
      } catch (e) { cleaned = false; }
      return {
        ok: shapeOk && !!saved.ok && kept && !!back.ok && cleaned,
        text: res.text + ' ｜ 导入时记下指纹=' + shapeOk
          + (o1 ? ('（' + o1.tool + ' / ' + String(o1.sha256).slice(0, 10) + '…）') : '（没有 origin）')
          + ' ｜ 界面当前项目=' + cur + ' ｜ ' + saved.text
          + ' ｜ 保存后指纹仍在=' + kept + (kept ? '' : '｜⚠️ 被整树写回丢掉了')
          + ' ｜ 收尾=' + back.text + ' ｜ 探针项目已删=' + cleaned
      };
    }
  }
];
