/* ============================================================
 * scripts/smoke/08-audit-palette.js — 关系审计面板与命令面板
 * ------------------------------------------------------------
 * 覆盖 renderer/app-audit.js 与 renderer/app-palette.js 的**用户可见行为**：
 *   · 审计面板能打开、渲染出 CLI 给的两份清单、条目可点击、能一键补链接
 *   · 命令面板能打开、能搜到节点与命令、键盘可选、Enter 能定位节点
 * 这两项是「把 AI 已有的能力接到人手上」，因此断言必须走真实 IPC 与真实 DOM，
 * 不能只测函数存在（RULES R1：断言要来自实际执行）。
 *
 * 数据安全：断言只读真实项目，补链接那一项先用 export-json 的能力无法覆盖写操作，
 * 故补链接**只断言"按钮存在且携带正确的 from/to"**，不真的写盘 ——
 * 冒烟运行在项目副本上（07 域已验证），但避免在副本里留下无谓改动。
 * ============================================================ */
'use strict';

// 真帧像素判据（"不再遮挡"那半）：像素统计的唯一实现 + 阈值单源
const frameStats = require('../vision/frame-stats.js');
const VTH = frameStats.THRESHOLDS;

/** 渲染层返回 JSON 的取回口（本域原为内联 `ctx.exec` + 手动 JSON.parse；迁移后多处复用 ✓） */
async function execJson(ctx, js) {
  const raw = await ctx.exec(js);
  try { return JSON.parse(raw); } catch (e) { return { ok: false, text: String(raw).slice(0, 300) }; }
}

/** 判别力证明开关（默认空 ⇒ 正常跑完全不生效 ✓）；逗号分隔多键 ⇒ 一趟跑完多条注入 ✓ */
const INJECT = process.env.MM_SMOKE_INJECT || '';
const MY_KEY = (k) => INJECT.split(',').indexOf('08-' + k) >= 0;

/* ---------------------------------------------------------------
 * 「取证时刻」的三条口径（本域**唯一**一份，见下方「关系审计面板：可关闭」那一段）
 *
 * 为什么需要它们：隐藏窗口的 `capturePage()` 会给**上一帧**（底座 `scripts/smoke-input.js`
 * 文件头就写着这条边界：`17-ui-polish.js` 有实测记录）。于是"关掉面板"与"拍到关掉之后的那一帧"
 * 之间隔着一个**没有上界的合成延迟** —— 而这个延迟既不是产品缺陷，也不是我们可以用固定睡眠猜中的。
 *
 * ⚠️ 不能换成固定 `sleep(500)`：那只是把一个竞态换成另一个（慢日照样拍旧帧，快日白等）。
 * ⚠️ 也不能用 `scripts/smoke/view-stability.js` 的 `waitStableView`：它等的是**DOM 视图签名**
 *    连续三次同一 —— 而这条缺陷里 DOM **早就对了**（`display:none`、`elementFromPoint` 全对），
 *    **旧帧对任何 DOM 探针都是不可见的** ⇒ 拿它等只会"第一次就稳定"地把旧帧放过去，等于没等。
 * ⇒ 唯一能回答"这一帧到底是不是关完之后那一刻"的，是**帧自己**：把关后那一帧与关前那一帧比。
 * --------------------------------------------------------------- */
/** 每一轮取帧前的等待（`settle` = ≥2 帧 rAF + 这一拍；与文件里其它处的 220ms 同口径） */
const FRAME_TICK = { delayMs: 220 };
/** 最多取几次帧（**上界**；到上界仍与关前同一帧 ⇒ 照旧判红，不许无限等） */
const MAX_FRAME_TRIES = 8;
/** 「这两次读的是同一帧」的判据：ROI 的 mean 差 < 它。
 *  标定（全链两轮实测）：真的重绘了 ⇒ 差 **84.6**（129.6 → 214.2）；拍到旧帧 ⇒ 差 **0.0**。
 *  取 0.1 是在"浮点噪声"与"最轻微的真实变化"之间 —— 9×9 ROI 全量统计（不采样）⇒ 同一帧逐位相同。 */
const SAME_FRAME_EPS = 0.1;

module.exports = [
  {
    name: '关系审计面板：打开后渲染出 orphans 与 mentions 两份清单',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           var st = app.getState();
           if (!st || !st.project) return { ok: false, text: 'no project loaded' };
           localStorage; // noop
           await app.openAudit();
           var p = document.getElementById('audit-panel');
           var visible = p && p.style.display !== 'none';
           var h3 = [].map.call(p.querySelectorAll('#audit-body h3'), function (x) { return x.textContent; });
           var body = p.querySelector('#audit-body').textContent || '';
           return {
             ok: visible && h3.length === 2 && /无引用但有内容/.test(h3[0]) && /正文提到却没建链接/.test(h3[1])
                 && body.indexOf('正在分析') < 0,
             text: 'visible=' + visible + ' h3=' + JSON.stringify(h3) + ' loading=' + (body.indexOf('正在分析') >= 0)
           };
         })()`
      );
      return r;
    }
  },
  {
    name: '关系审计面板：清单经真实 IPC 取得（与 CLI 结果一致，非渲染层自算）',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           var st = app.getState();
           var name = st.project.name;
           // 面板用的 IPC 结果 vs 直接调 CLI 的结果（主进程 runCli）
           var audit = await window.desktop.app.audit(name);
           if (!audit || !audit.orphans || !audit.mentions) return { ok: false, text: 'audit IPC 返回不完整' };
           var panelTxt = document.querySelector('#audit-panel #audit-body').textContent || '';
           // 面板里显示的孤立节点数应等于 IPC 报的 contentOrphans
           var shownCount = /无引用但有内容（(\\d+)）/.exec(document.querySelector('#audit-panel #audit-body').textContent);
           var n = shownCount ? Number(shownCount[1]) : -1;
           return {
             ok: Array.isArray(audit.orphans.items) && Array.isArray(audit.mentions.items)
                 && n === audit.orphans.contentOrphans,
             text: 'contentOrphans=' + audit.orphans.contentOrphans + ' 面板显示=' + n
                 + ' mentions=' + audit.mentions.mentions
           };
         })()`
      );
      return r;
    }
  },
  {
    name: '关系审计面板：mentions 条目带「补链接」按钮且携带正确的 from/to',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           var st = app.getState();
           var audit = await window.desktop.app.audit(st.project.name);
           var btns = document.querySelectorAll('#audit-panel .audit-link-btn');
           var m = (audit.mentions && audit.mentions.items) || [];
           if (!m.length) return { ok: btns.length === 0, text: '本项目无 mentions（0 条）→ 无按钮也正确' };
           var first = btns[0];
           if (!first) return { ok: false, text: '有 ' + m.length + ' 条 mentions 但没渲染出按钮' };
           var f = first.getAttribute('data-from'), t = first.getAttribute('data-to');
           var hit = m.some(function (x) { return x.from === f && x.to === t; });
           return { ok: btns.length === m.length && hit, text: '按钮=' + btns.length + ' 条=' + m.length + ' 首项 ' + f + '→' + t };
         })()`
      );
      return r;
    }
  },
  {
    name: '关系审计面板：点击孤立节点条目会定位并打开该节点详情',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           var li = document.querySelector('#audit-panel li[data-node]');
           if (!li) return { ok: true, text: '本项目无孤立节点条目（跳过）' };
           var id = li.getAttribute('data-node');
           li.click();
           await new Promise(function (res) { setTimeout(res, 120); });
           var st = app.getState();
           var sel = st.jm && st.jm.get_selected_node ? st.jm.get_selected_node() : null;
           var box = document.querySelector('.float-detail');
           return {
             ok: !!sel && sel.id === id && !!box && box.style.display !== 'none',
             text: '目标=' + id + ' 选中=' + (sel && sel.id) + ' 详情可见=' + (!!box && box.style.display !== 'none')
           };
         })()`
      );
      return r;
    }
  },
  {
    /* 【可见性判据迁移（2026-10-09）】原判据 = 审计面板自己的 `style.display === 'none'`
     *  （V1 门禁在册欠账之一）。问题：**"遮挡"是层叠关系，不是某个元素自己的行内样式** ——
     *  面板没关干净却也不在顶上时，`display` 照样是 'none' ⇒ 断言恒绿 ✗。
     *  迁到真判据：① 命中测试（`elementFromPoint`）—— 关前必须在面板层上、关后**必须不在**；
     *  ② 真帧像素 —— 面板的 `.overlay` 是 45% 暗遮罩，关掉后同一小块区域必须**变亮**
     *  （`analyzeRegion().mean` 的差值，阈值单源在 `thresholds.paint.minOverlayBrighten`）。
     *
     * 【取帧时序修复（2026-10-30）】上面三条判据**都没错**，坏掉的是**取证时刻**：
     * 关掉面板之后只等一拍就 `capture()`，而隐藏窗口的 `capturePage()` 会给**上一帧**
     * （边界写在底座 `scripts/smoke-input.js` 文件头）。两轮全链的原始报文（同一台机器、
     * 同一份代码逻辑）：
     *   · 上次 PASS：`display: flex → none` ✓、命中测试两项都对 ✓、`mean 129.6 → 214.2`、变亮 **84.6**；
     *   · 这次 FAIL：`display: flex → none` ✓、命中测试两项都对 ✓、`mean 129.6 → 129.6`、变亮 **0.0**。
     *   ⇒ 面板真的关了（DOM 三项全对），**而像素一位小数都没变** ⇒ 两次读的是**同一帧**。
     *   交叉验证（`.overlay` 是 `rgba(15,23,42,0.45)` ⇒ 混色 `0.55·v + 0.45·26.7`）：
     *   把 `v = 214.2` 代进去得 **129.8**，与实测的关前 129.6 吻合 ⇒ 暗帧就是**同一个取样点的
     *   遮罩态**，不是取样点挪了位置（"取样点落在别处"这个假设被这条算术排除掉了）。
     * 修法**只动取证时刻，判据一个字不放宽**（阈值仍是 20、变亮那一档照旧在、`display` 也不再是
     * 唯一依据）：关后**重取帧**，直到这一帧与关前那一帧**真的不同**（判据 = ROI 的 `mean` 差
     * ≥ `SAME_FRAME_EPS`）；每轮之间等 ≥2 帧 + 一拍，并把「**第几次取帧才变**」写进报文。
     * **有上界**（`MAX_FRAME_TRIES`）：到上界仍与关前同一帧 ⇒ **照旧判红** ——
     * 既不许无限等，也不许把 0.0 说成"环境噪声"（那样这条判据就再也不会因遮挡而红了 ✗）。
     * ⚠️ 重取的是**关后**那一帧；**关前**那一帧不重取（它两轮实测都是新的：两次都读到 129.6、
     *   且与上面那条混色算术吻合）。万一将来关前那一帧也陈旧了，这里的表现是**假红**
     *   （报文会写"第 8 次取帧仍是关前那一帧"），绝不会变成假绿 ✓。
     * 判别力证明：`MM_SMOKE_INJECT=08-keep-open`（把 `close` 变成空操作 = 面板真的不关）⇒
     *   **必须判红**，且报文点名是「命中测试」还是「变亮」没过（见下面 `verdictText`）。 */
    name: '关系审计面板：可关闭（关闭后不再遮挡界面 · elementFromPoint 不再命中面板 + 真帧变亮）',
    run: async (ctx) => {
      if (!ctx.input) return { ok: false, text: '没有真输入底座（ctx.input 缺失）⇒ 取不到真帧 = 红' };
      // 取样点：① 面板中心（关前应命中卡片） ② 遮罩左上角内 20px 处（关前应命中遮罩本身）
      const open = await execJson(ctx, `(function () {
        var app = window.MMApp;
        app.openAudit();
        var panel = document.getElementById('audit-panel');
        var pr = panel.getBoundingClientRect();
        var p1 = { x: Math.round(pr.left + pr.width / 2), y: Math.round(pr.top + pr.height / 2) };
        var p2 = { x: Math.round(pr.left + 20), y: Math.round(pr.top + 20) };
        function at(p) { var e = document.elementFromPoint(p.x, p.y); return e ? (e.id ? ('#' + e.id) : e.className || e.tagName) : null; }
        var inPanel = function (p) { var e = document.elementFromPoint(p.x, p.y); return !!(e && panel.contains(e)); };
        return JSON.stringify({ ok: true, display: panel.style.display, p1: p1, p2: p2, dpr: window.devicePixelRatio || 1,
          overlay: { left: Math.round(pr.left), top: Math.round(pr.top), width: Math.round(pr.width), height: Math.round(pr.height) },
          before1: at(p1), before2: at(p2), beforeIn1: inPanel(p1), beforeIn2: inPanel(p2) });
      })()`);
      const dpr = open.dpr || 1;
      // ROI 在**几何拿到之后**就定下来（原先定在两帧之后）：重取帧那一层要拿它逐次比对
      const roi = { x: (open.p2.x - 4) * dpr, y: (open.p2.y - 4) * dpr, width: 9 * dpr, height: 9 * dpr };
      // ① 关面板**之前**那一帧（取样点此刻压在 `.overlay` 的暗遮罩上）
      await ctx.input.settle(FRAME_TICK);
      const imgBefore = await ctx.input.capture();
      const stBefore = frameStats.analyzeRegion(imgBefore, roi);
      // ② 关掉面板（注入档 `08-keep-open` = 空操作 ⇒ 判别力证明）
      const after = await execJson(ctx, `(function () {
        var app = window.MMApp;
        // —— 判别力证明（\`MM_SMOKE_INJECT=08-keep-open\`）：复刻**旧判据骗得过**的那种违规 ——
        //   面板"关不干净"（这里直接不关）⇒ 命中测试与真帧变亮**都必须判红** ✓
        var doClose = ${JSON.stringify(!MY_KEY('keep-open'))};
        if (doClose) document.getElementById('audit-close').click();
        var panel = document.getElementById('audit-panel');
        var p1 = ${JSON.stringify(open.p1)}, p2 = ${JSON.stringify(open.p2)};
        function at(p) { var e = document.elementFromPoint(p.x, p.y); return e ? (e.id ? ('#' + e.id) : e.className || e.tagName) : null; }
        var inPanel = function (p) { var e = document.elementFromPoint(p.x, p.y); return !!(e && panel.contains(e)); };
        return JSON.stringify({ ok: true, display: panel.style.display, after1: at(p1), after2: at(p2),
          afterIn1: inPanel(p1), afterIn2: inPanel(p2) });
      })()`);
      /* ③ 关面板**之后**取帧：**等它真的重绘了**再判。
       * 这一层只管"取证"（这一帧新不新），**不碰判据** —— 判据在下面照原样算。
       * 停下来的条件只有一个：这一帧与关前那一帧**不是同一帧**。 */
      const means = [];          // 每次取帧的 ROI mean（写进报文：旧帧长什么样一眼看得见）
      let stAfter = null, frameTry = 0, frameChanged = false;
      for (let i = 1; i <= MAX_FRAME_TRIES; i++) {
        await ctx.input.settle(FRAME_TICK);
        /* 判别力证明（`MM_SMOKE_INJECT=08-stale-frame`）：让**第一次**取帧拿到"旧帧"
         *  —— 直接把关前那一帧的统计当成这一次的结果，复刻全链实测的那次 FAIL
         *  （`mean 129.6 → 129.6`、变亮 `0.0`）。有重取 ⇒ 第 2 次就变、判据照旧 PASS；
         *  把重取拿掉 ⇒ 立刻退回那次 FAIL ✗ —— 这条注入就是"重取这一层不是摆设"的证明。 */
        const st = (MY_KEY('stale-frame') && i === 1)
          ? stBefore
          : frameStats.analyzeRegion(await ctx.input.capture(), roi);
        stAfter = st;
        frameTry = i;
        means.push(st.mean);
        if (Math.abs(st.mean - stBefore.mean) >= SAME_FRAME_EPS) { frameChanged = true; break; }
      }
      const brighten = stAfter.mean - stBefore.mean;
      const minBrighten = VTH.paint.minOverlayBrighten;
      const hitOk = open.beforeIn1 === true && open.beforeIn2 === true
        && after.afterIn1 === false && after.afterIn2 === false;
      const pixOk = brighten >= minBrighten;
      /* 报文要能一眼看出**是哪一项没过**（R1d：拒绝要响亮、要点名），
       * 并且要有「第 N 次取帧」—— 它证明这一轮的读数**不是靠运气**拍到的 ✓ */
      const frameNote = !frameChanged
        ? '**仍是关前那一帧**（已取到上界 ' + MAX_FRAME_TRIES + ' 次；同一帧判据 = mean 差 < '
          + SAME_FRAME_EPS + '）'
        : (frameTry === 1
          ? '就变了（关前 / 关后各拍一次，没读到旧帧；每轮之间等 ≥2 帧 + ' + FRAME_TICK.delayMs + 'ms）'
          : '才变（前 ' + (frameTry - 1) + ' 次读到的都与关前同一帧 = 旧帧；每轮之间等 ≥2 帧 + '
            + FRAME_TICK.delayMs + 'ms）');
      const verdictText = (hitOk && pixOk) ? '三项全过'
        : '❌ ' + [(hitOk ? '' : '命中测试'), (pixOk ? '' : '变亮')].filter(Boolean).join(' + ') + ' 没过';
      return {
        ok: hitOk && pixOk,
        text: 'display: ' + open.display + ' → ' + after.display
          + ' ｜ 命中测试：关前[中心=' + open.before1 + ' 遮罩=' + open.before2 + ' 都在面板层上='
          + (open.beforeIn1 && open.beforeIn2) + '] 关后[中心=' + after.after1 + ' 遮罩=' + after.after2
          + ' 都不在面板层上=' + (!after.afterIn1 && !after.afterIn2) + ']'
          + ' ｜ 真帧取样点(' + open.p2.x + ',' + open.p2.y + ') 关前 mean=' + stBefore.mean.toFixed(1)
          + ' 关后 mean=' + stAfter.mean.toFixed(1) + ' 变亮=' + brighten.toFixed(1)
          + '（阈值 ≥' + minBrighten + '）'
          + ' ｜ 取证：第 ' + frameTry + ' 次取帧' + frameNote
          + ' ｜ 各次取帧 mean=' + means.map((m) => m.toFixed(1)).join(' → ')
          + ' ｜ 判定：' + verdictText
      };
    }
  },
  {
    name: '命令面板：Ctrl+P 打开 ⇒ **只列命令**（用户 A 决定：节点不再混进来 ✓）',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
           // openPalette 是异步的（await IPC 拉取节点清单）：187 节点 comnet 固定 250ms
           // 不够 → 轮询等待 palette-item 渲染（≤3s）再断言，避免 flaky FAIL。
           var deadline = Date.now() + 3000;
           var items = [];
           while (Date.now() < deadline) {
             await new Promise(function (res) { setTimeout(res, 100); });
             items = document.querySelectorAll('#palette .palette-item');
             if (items.length > 0) break;
           }
           var p = document.getElementById('palette');
           var visible = p && p.style.display !== 'none';
           var hints = [].map.call(items, function (x) { return (x.querySelector('.palette-hint') || {}).textContent; });
           return {
             ok: visible && items.length > 0 && hints.indexOf('节点') < 0 && hints.indexOf('命令') >= 0,
             text: 'visible=' + visible + ' 项数=' + items.length + ' 含节点=' + (hints.indexOf('节点') >= 0) + ' 含命令=' + (hints.indexOf('命令') >= 0)
           };
         })()`
      );
      return r;
    }
  },
  {
    /* 【口径修正 2026-10-13】旧名"结果均含该串"是**由实现决定的口径**：引擎的 `fuzzyMatch`
     * （`src/palette-rank.js`）是**子序列**匹配 —— 任何子串都是子序列，但子序列不必是子串
     * （+338 节点后确实出现两条：命中却没有连续的 "tcp"）⇒ 旧判据把**正确结果判成错** ✗。
     * 现判据 = **用引擎现算期望**：同一批候选（同一个 IPC）+ 同一个 `rankPalette`（面板唯一那份），
     * 再要求面板结果与它**逐项同序相等**。
     * 为什么"逐项同序"比"⊆ 且条数相等"更咬得住：后者只锁**集合**，而面板的**顺序**同样是用户可见契约
     * （第一条就是 Enter 会跳过去的那条 ⇒ 下一条断言整条押在它身上）；且下面对**两个方向**都红：
     *   ① 面板漏掉引擎认的命中（旧判据放过的正是这一类 ✗）② 面板混进引擎不认的行 ✗。
     * 判别力证明：`MM_SMOKE_INJECT=08-substr`（退回旧口径 ⇒ 必红 ✓）；
     * 另有一次**真编辑**版（把 ok 表达式换成旧判据 ⇒ 必红 ⇒ 还原后 SHA-256 逐字节相同 ⇒ 复绿 ✓）。 */
    name: '命令面板：模糊搜索「TCP」的结果**逐项同序等于引擎现算的命中集**（子序列口径，不是"含该串"）',
    run: async (ctx) => {
      // P3：面板只留命令 ⇒ 搜节点必须先切到节点模式 ✓
      await ctx.exec('window.MM.openPaletteNodes && window.MM.openPaletteNodes(); 1');
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           var st = app.getState();
           var inp = document.getElementById('palette-input');
           inp.value = 'TCP';
           inp.dispatchEvent(new Event('input'));
           await new Promise(function (res) { setTimeout(res, 250); });
           var labels = [].map.call(document.querySelectorAll('#palette .palette-item'), function (x) {
             return x.querySelector('.palette-label').textContent;
           });
           // ── 现算期望：**同一批候选**（同一个 IPC）+ **同一个引擎**（面板唯一那份 rankPalette）──
           // 候选来源与 renderer/app-palette.js 的 refresh() 逐字同源（window.desktop.app.nodes 的 n.topic）；
           // "什么算命中"一个字都不在这里手写 ⇒ 引擎改口径时这条断言跟着走 ✓（旧判据正是死在这一点上 ✗）
           var list = await window.desktop.app.nodes(st.project.name);
           var entries = ((list && list.nodes) || []).map(function (n) {
             return { kind: 'node', id: n.id, label: n.topic };
           });
           var expected = window.MMPaletteRank.rankPalette(entries, 'TCP', 50).map(function (e) { return e.label; });
           var missing = expected.filter(function (l) { return labels.indexOf(l) < 0; });
           var extra = labels.filter(function (l) { return expected.indexOf(l) < 0; });
           var same = labels.length === expected.length && labels.every(function (l, i) { return l === expected[i]; });
           // 观测（不进判定）：旧口径"全部含该串"会判红几条 —— 留证"旧判据错在哪" ✓
           var notSubstr = expected.filter(function (l) { return !/tcp/i.test(l); });
           return { ok: ${JSON.stringify(MY_KEY('substr'))}
               ? (labels.length > 0 && labels.every(function (l) { return /tcp/i.test(l); }))   // ← 旧判据原文（注入用）
               : (same && expected.length > 0),
             text: '面板结果=' + labels.length + ' 引擎现算=' + expected.length + ' 逐项同序相等=' + same
               + ' ｜ 面板漏=' + JSON.stringify(missing.slice(0, 3)) + ' 面板多=' + JSON.stringify(extra.slice(0, 3))
               + ' ｜ 首项=' + JSON.stringify(labels.slice(0, 3))
               + ' ｜ 候选=' + entries.length + '（与面板同一个 IPC 取回）'
               + ' ｜ 只有子序列命中、**不含连续子串**的=' + JSON.stringify(notSubstr.slice(0, 3)) + '（' + notSubstr.length + ' 条）'
               + ' ｜ 旧口径（全部含子串）本应判红=' + (notSubstr.length > 0)
               + ${JSON.stringify(MY_KEY('substr') ? ' ｜ ⚠️ **判别力证明注入**=08-substr（旧口径）' : '')} };
         })()`
      );
      return r;
    }
  },
  {
    name: '命令面板：Enter 定位到选中节点并打开其详情，Esc 关闭',
    run: async (ctx) => {
      // P3：面板只留命令 ⇒ 搜节点必须先切到节点模式 ✓
      await ctx.exec('window.MM.openPaletteNodes && window.MM.openPaletteNodes(); 1');
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           var inp = document.getElementById('palette-input');
           inp.value = 'TCP';
           inp.dispatchEvent(new Event('input'));
           await new Promise(function (res) { setTimeout(res, 250); });
           var first = document.querySelector('#palette .palette-item');
           if (!first) return { ok: false, text: '无结果' };
           var label = first.querySelector('.palette-label').textContent;
           inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
           await new Promise(function (res) { setTimeout(res, 200); });
           var st = app.getState();
           var sel = st.jm && st.jm.get_selected_node ? st.jm.get_selected_node() : null;
           var closed = document.getElementById('palette').style.display === 'none';
           return {
             ok: !!sel && sel.topic === label && closed,
             text: '目标=' + label + ' 选中=' + (sel && sel.topic) + ' 已关闭=' + closed
           };
         })()`
      );
      return r;
    }
  },
  {
    name: '命令面板：命令项可执行（选中「关系审计」后审计面板被打开）',
    run: async (ctx) => {
      // 第一版用「展开全部是否让可见节点变多」来验证，结果永远相等 —— 因为 jsMind
      // 折叠时节点仍留在 DOM 里（靠样式隐藏），数 jmnode 数量测不出折叠。
      // 改用**不依赖 jsMind 内部实现**的可观测副作用：命令执行后 DOM 出现面板。
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           app.closeAudit();
           document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
           // 轮询直到过滤生效：openPalette 异步渲染 + input 过滤是 timer，全链 verify
           // （CLI 集成后紧接冒烟）负载高时固定 250ms 等待不够（实测首项停在空查询的
           // 「展开全部」），改为每 150ms 重输一次并检查首项，最长 ~4.5s（同本条断言
           // 上方 Ctrl+P 那条的轮询先例）。
           var first = null, hint = null, label = null;
           for (var t = 0; t < 30; t++) {
             await new Promise(function (res) { setTimeout(res, 150); });
             var i2 = document.getElementById('palette-input');
             if (!i2) continue;
             i2.value = '关系审计';
             i2.dispatchEvent(new Event('input'));
             first = document.querySelector('#palette .palette-item');
             if (!first) continue;
             label = first.querySelector('.palette-label');
             if (label && label.textContent.indexOf('关系审计') >= 0) break;
           }
           hint = first && first.querySelector('.palette-hint');
           if (!first || !label || label.textContent.indexOf('关系审计') < 0) {
             return { ok: false, text: '搜不到「关系审计」命令项' };
           }
           first.click();
           await new Promise(function (res) { setTimeout(res, 500); });
           var p = document.getElementById('audit-panel');
           return {
             ok: !!p && p.style.display !== 'none'
                 && (label.textContent || '').indexOf('关系审计') >= 0
                 && (hint.textContent || '') === '命令',
             text: '首项=' + JSON.stringify(label.textContent) + ' 类型=' + (hint && hint.textContent)
                 + ' 审计面板可见=' + (!!p && p.style.display !== 'none')
           };
         })()`
      );
      return r;
    }
  },
  {
    name: '命令面板：空查询时**只列命令**（节点不混入；命令必须在截断前可见 ✓）',
    run: async (ctx) => {
      // 回归断言（P3 后仍有效）：空查询下**命令必须都看得见** —— 旧实现里 131 个节点占满前 50 名，
      // 命令被 slice 全部截掉 —— 打开面板一个命令都看不到。
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           app.closeAudit();
           app.closePalette();
           await app.openPalette();
           await new Promise(function (res) { setTimeout(res, 300); });
           var items = document.querySelectorAll('#palette .palette-item');
           var kinds = [].map.call(items, function (x) {
             return (x.querySelector('.palette-hint') || {}).textContent;
           });
           var nMention = items.length;
           var firstKind = kinds[0];
           app.closePalette();
           return {
             ok: nMention > 0 && kinds.indexOf('命令') >= 0 && kinds.indexOf('节点') < 0 && firstKind === '命令',
             text: '项数=' + nMention + ' 命令数=' + kinds.filter(function (k) { return k === '命令'; }).length
                 + ' 节点数=' + kinds.filter(function (k) { return k === '节点'; }).length + ' 首项类型=' + firstKind
           };
         })()`
      );
      return r;
    }
  },
  {
    // 这一条锁住一个**曾经的真实数据丢失路径**：补链接原先用 openProject() 重载项目，
    // 而本工程的编辑只存在内存里（要用户点保存才落盘），于是"补链接"会静默丢弃
    // 用户未保存的编辑、并清空撤销栈。现改为就地补链，此处断言该性质不被改回。
    name: '关系审计：补链接不丢未保存的内存编辑、不重置撤销栈（就地补链）',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           var st = app.getState();
           var jm = st.jm;
           var audit = await window.desktop.app.audit(st.project.name);
           var m = (audit.mentions && audit.mentions.items) || [];
           if (!m.length) return { ok: true, text: '本项目无 mentions 可补（跳过真实写入）' };
           // 造一个"未保存的内存编辑"：加节点只进内存与撤销栈，不落盘
           var tmpId = 'audit-probe-tmp';
           jm.add_node('root', tmpId, '未保存探针', { detail: '' });
           var existedBefore = !!jm.get_node(tmpId);
           var pair = m[0];
           await app.addLinkFromAudit(pair.from, pair.to);
           var keptEdit = !!jm.get_node(tmpId);          // 未保存编辑未被丢弃
           var keptHistory = st.history.canUndo();       // 撤销栈未被重置
           var fn = jm.get_node(pair.from);
           var linkedInMem = !!(fn && fn.data && (fn.data.links || []).some(function (l) {
             return l && l.id === pair.to;
           }));
           jm.remove_node(tmpId);                        // 清理探针（仅内存）
           return {
             ok: existedBefore && keptEdit && keptHistory && linkedInMem,
             text: '未保存编辑保留=' + keptEdit + ' 撤销栈保留=' + keptHistory
                 + ' 内存已补链=' + linkedInMem + ' 对=' + pair.from + '→' + pair.to
           };
         })()`
      );
      return r;
    }
  },
  {
    // 锁住一个**真实的数据安全缺陷**：`runCli()` 调起的 CLI 是**另一个进程**，
    // 它自己算 `projects/` 路径。若宿主不把沙箱目录传给它，CLI 会写**真实项目** ——
    // 冒烟里任何经 CLI 的写操作（如上面的"补链接"）都会污染用户数据。
    // 本断言做端到端证明：补链接后从**沙箱副本**重新读回，链接必须在那里。
    // 若 CLI 仍写真实目录，则渲染层读的是沙箱、CLI 写的是真实 → 读不到 → 失败。
    name: '冒烟沙箱：经 CLI 的写操作也落在副本上（CLI 子进程遵守沙箱目录）',
    run: async (ctx) => {
      const r = await ctx.exec(
        `(async function () {
           var app = window.MMApp;
           var st = app.getState();
           var name = st.project.name;
           var file = st.project.file;
           // 前置：本项目确实在冒烟副本里（07 域已断言过，这里再确认一次以自洽）
           var inSandbox = /ai-mind-map-smoke-/.test(file || '');
           var audit = await window.desktop.app.audit(name);
           var m = (audit.mentions && audit.mentions.items) || [];
           if (!m.length) return { ok: inSandbox, text: '无 mentions 可补；沙箱=' + inSandbox };
           var pair = m[0];
           await app.addLinkFromAudit(pair.from, pair.to);
           // 从磁盘（沙箱副本）重新读回，确认 CLI 的写入落在这里
           var reread = await window.desktop.project.read(name);
           function find(node, id) {
             if (!node) return null;
             if (node.id === id) return node;
             var kids = node.children || [];
             for (var i = 0; i < kids.length; i++) { var r = find(kids[i], id); if (r) return r; }
             return null;
           }
           var from = find(reread.data.data, pair.from);
           var hit = !!(from && (from.links || []).some(function (l) {
             return l && l.id === pair.to;
           }));
           return {
             ok: inSandbox && hit,
             text: '沙箱=' + inSandbox + ' CLI 写入落在副本=' + hit
                 + ' 对=' + pair.from + '→' + pair.to + ' 文件=' + file
           };
         })()`
      );
      return r;
    }
  }
  ,
  {
    name: '命令面板：上次停在**节点模式**，再打开也必须回到**命令模式**（真机反馈④：否则像坏了一样 ✗）',
    run: async (ctx) => {
      // ① 先切进节点模式（面板内的「搜索节点…」命令走的就是这条）
      await ctx.exec('(async function () { window.MM.openPaletteNodes(); await new Promise(function (r) { setTimeout(r, 600); }); return 1; })()');
      const inNode = await ctx.exec('(function () { var items = document.querySelectorAll("#palette .palette-item"); var hints = [].map.call(items, function (x) { return (x.querySelector(".palette-hint") || {}).textContent; }); return JSON.stringify({ mode: window.MM.paletteMode(), hasNode: hints.indexOf("节点") >= 0, n: items.length }); })()');
      const nodeState = JSON.parse(inNode);
      // ② 关掉（Esc），再按 Ctrl+P 打开 —— 必须回命令模式 ✓
      await ctx.exec('(function () { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return 1; })()');
      await new Promise((r) => setTimeout(r, 250));
      await ctx.exec('(function () { document.dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true })); return 1; })()');
      let back = null;
      for (let i = 0; i < 30; i++) {
        const r2 = await ctx.exec('(function () { var items = document.querySelectorAll("#palette .palette-item"); var hints = [].map.call(items, function (x) { return (x.querySelector(".palette-hint") || {}).textContent; }); return JSON.stringify({ mode: window.MM.paletteMode(), hasNode: hints.indexOf("节点") >= 0, hasCmd: hints.indexOf("命令") >= 0, n: items.length }); })()');
        back = JSON.parse(r2);
        if (back.n > 0 && back.mode === "cmd") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      // ③ 收尾：**把开着的面板都关掉**，不给后续断言留一个全屏模态 ✓
      // ⚠️ 这里原先只关了命令面板 —— 而本域**上游的两条断言**（补链接 / 沙箱写入）都会经
      //    `addLinkFromAudit` → `openAudit()` 把**审计面板**重新打开，它就一直开到了下一个域。
      //    实测代价：审计卡 720x668 盖住屏幕中部，域 25「点线开笔记」的采样点正好落在卡上，
      //    真鼠标点击打到审计列表 ⇒ 打开的不是那篇笔记（断言红，且看不出跟本域有关 ✗）。
      //    跨域状态泄漏只能在**制造它的地方**收口（域 25 不该替别人擦桌子）。
      await ctx.exec('(function () { if (window.MMApp && window.MMApp.closeAudit) window.MMApp.closeAudit(); if (window.MMApp && window.MMApp.closePalette) window.MMApp.closePalette(); return 1; })()');
      const okAll = nodeState.mode === "node" && nodeState.hasNode === true
        && !!back && back.mode === "cmd" && back.hasNode === false && back.hasCmd === true;
      return { ok: okAll,
        text: '节点模式时=' + JSON.stringify(nodeState) + ' ｜ 重开后=' + JSON.stringify(back) };
    }
  }
];
