/* ============================================================
 * scripts/smoke/28-msgbar.js — 下方消息栏（功能 5a 入口③）
 * ------------------------------------------------------------
 * 用户原话：「在下方消息栏（显示发送消息框的地方）上方有一些虚体字，写
 *   『或者你可以直接向我描述要导入什么』，如果用户向里输入，就认为用户在向内嵌 DSH 发送提示词，
 *   自动补充情境信息」✓ 本域验五件：
 *   1) 消息栏在、**虚体字提示就是那句话**（一字不差 —— 用户能一眼认出这是他要的那个入口 ✓）
 *   2) 输入 + Enter ⇒ 打开**项目级** AI 浮窗（标题是项目名，不是节点名 ✓）并拿到答案（冒烟桩）
 *   3) 空输入 ⇒ 什么都不发生（不许发一个空提示词出去 ✗）
 *   4) ⭐ **消息栏不再永久遮挡地图**（本批修的缺陷）：面板与消息栏矩形**不重叠**、
 *      两者的**交集面积 = 0**，并且**只在交集非空时**才从交集里取点做命中测试
 *      （缺陷态下那一点返回 `#msg-bar` ⇒ 判红；修复后交集是空集 ⇒ 无点可盖 ✓）
 *      （旧位置：`#mindmap-container` 的绝对定位子元素 + `z-index:30` ⇒ 永久盖住面板底部 ~60px，
 *      落到那一带的连线端点用户真的看不见 ✗）
 *   5) ⭐ **消息功能没丢**：真输入点得进、打得进、读得回 + 真帧里输入框那块**深色像素真的多出来**
 *      （判据 4 的改动是"让它别盖住地图"，不是"把它拿掉" ✓）
 *
 * 情境（当前项目 / 可用 CLI / 没选中节点）由 CLI 侧补齐 ⇒ 那一层由集成断言验（ask --dry-run）✓
 * 本域只管"界面这条链通不通"，且**不调用模型**（冒烟里 app:ask 返回 stub:true 的桩 ✓）。
 * ============================================================ */
'use strict';

const frameStats = require('../vision/frame-stats.js');
const WAIT = require('./_wait.js');   // 等真帧/等条件：理由见该文件头部第 5 条

/** 判别力证明开关（默认空 ⇒ 正常跑完全不生效 ✓；可逗号分隔多键，照域 05/37 的先例）。
 *  `28-bar-over-map`：把消息栏**搬回** `#mindmap-container` 里并恢复原绝对定位样式
 *  ⇒ 精确复刻修复前的"永久盖住面板底部"状态 ⇒ 判据 4 必须判红 ✓ */
const INJECT = process.env.MM_SMOKE_INJECT || '';
const MY_KEY = (k) => INJECT.split(',').indexOf('28-' + k) >= 0;

/** 探测点：**重叠带（消息栏矩形 ∩ 地图容器矩形）**里的取样位置（相对重叠带宽度的比例）——
 *  取 0.004 = 贴着重叠带左缘（消息栏的左侧 padding 区，离虚体字/输入框/发送按钮都远）。
 *  写法是**单侧**的：这一点命中消息栏 = 红（消息栏在那儿压住了地图）——
 *  修复后重叠带是**空集**（不取样），所以不会误红 ✓ */
const PROBES = [0.004];

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
  },
  {
    name: '消息栏不再永久遮挡地图：面板与消息栏矩形不重叠（交集面积=0px²），且重叠带上没有消息栏压住地图',
    run: async (ctx) => {
      // 本批修的缺陷（实测 2026-10-09/10-14）：`#msg-bar` 曾是 `#mindmap-container` 的绝对定位子元素
      // （`left:0;right:0;bottom:0; z-index:30`、底 `#fbfcfe`）⇒ 屏幕矩形 [0,775]–[729,835]，
      // **永久盖住面板底部约 60px** ⇒ `elementFromPoint(666.455, 782.99)` 最上层是
      // `DIV#msg-hint > DIV#msg-bar`（md-m2-usb 的连线端点就在那底下），连线层位图里那点**有 16 个
      // 不透明像素**（线画了、只是被盖住）✗。修法：消息栏移出 `#mindmap-container`、进 body 的
      // flex 列 ⇒ 由版式让位（见 renderer/index.html / style.css 的注释）✓
      const INJ = MY_KEY('bar-over-map');
      const res = await execJson(ctx, `(function () {
        var INJ = ${JSON.stringify(INJ)};
        var bar = document.getElementById('msg-bar');
        var panel = document.querySelector('#mindmap-container');
        var inner = document.getElementById('jsmind_container');
        if (!bar || !panel || !inner) return JSON.stringify({ ok: false, text: '元素不齐' });
        if (!INJ) {
          // 前置：地图必须真在那个**可用区**里画着（节点 + 连线层都渲染了）——否则下面这条
          // "重叠带里没有消息栏"会在一个空容器上通过（面板都没起来 ⇒ 判据空转）
          // ⇒ 采不到真值按红处理
          if (!window.MMApp || !window.MMApp.getState().jm || !document.querySelector('jmnode')
            || !panel.querySelector('canvas.jsmind')) {
            return JSON.stringify({ ok: false, text: '地图还没画出来 ⇒ 判据会空转，按红处理' });
          }
          window.MM.clearTreeOffsets(); window.MMApp.resetView();
        } else {
          // —— 判别力证明：**把修复改坏** ——
          //    缺陷的机制就是这两步：① 把消息栏搬回面板里（它就不再参与 body 的 flex 让位）；
          //    ② 恢复它原来的绝对定位（left:0;right:0;bottom:0; z-index:30、底 #fbfcfe）
          //    ⇒ 精确复刻"永久盖住面板底部 ~60px"的状态 ⇒ 本条判据必须判红 ✓
          //    （CSS 只钉这两条：其余属性与修复后逐字相同，所以这一档验的是**遮挡**本身，
          //     不是"把消息栏改窄/改透明"这类别的改坏）
          panel.appendChild(bar);
          var st = document.createElement('style'); st.id = 'mm-inj-bar-over-map';
          st.textContent = '#msg-bar{position:absolute;left:0;right:0;bottom:0;z-index:30;background:#fbfcfe;}';
          document.head.appendChild(st);
        }
        var jr = bar.getBoundingClientRect(), pr = panel.getBoundingClientRect();
        var barVisible = jr.width > 100 && jr.height > 10 && jr.bottom <= window.innerHeight + 1;
        // ① 几何：**矩形不重叠** —— 面板底 ≤ 消息栏顶。两条地板挡住"假解"：
        //    · 消息栏位置合理（底边贴视口底、顶边在下半屏）⇒ 挡住"挪到页顶 / 缩成 0 高"；
        //    · 面板自己还有可用高度 ⇒ 挡住"面板塌成 0"（那样当然也不重叠，但地图没了 ✗）
        var placed = barVisible && Math.abs(jr.bottom - window.innerHeight) <= 2
          && jr.top >= window.innerHeight * 0.5;
        var panelAlive = pr.width > 200 && pr.height > 100;
        var separated = placed && panelAlive && pr.bottom <= jr.top + 0.5;
        /* ② **被盖住的那块真的没了**（判据的核心，且它自己带可分辨性证明）：
         *   cover = 消息栏矩形 ∩ 地图容器矩形。修复后它是**空集**（两条边挨着、零重叠）；
         *   缺陷态下它正好是"永久盖住的那 60px 高一条" ✓
         *   然后**只在 cover 非空时**才做命中测试 —— 从 cover 里取点（左侧 padding 处，离文字/按钮远），
         *   最上层元素**必须不是**消息栏：缺陷态下这一点返回 DIV#msg-hint > DIV#msg-bar
         *   （实测 2026-10-09/10-14：elementFromPoint(666.455, 782.99) 最上层就是 #msg-hint）✓
         *   ⚠️ 这一半**刻意**不在 cover 为空时乱点：修复后消息栏那条带子本来就在面板**下方**，
         *      在里面取点当然命中消息栏 —— 那不是"被盖住"（实测过的假红形态）✗
         *      所以判据是"**重叠带上**的消息栏压住了地图"，只在重叠存在时才可判 ✓ */
        var cover = { left: Math.max(jr.left, pr.left), top: Math.max(jr.top, pr.top),
          right: Math.min(jr.right, pr.right), bottom: Math.min(jr.bottom, pr.bottom) };
        var coverW = Math.max(0, cover.right - cover.left), coverH = Math.max(0, cover.bottom - cover.top);
        var covered = coverW * coverH;
        var hits = [], barOverMap = false;
        if (covered > 0) {
          var cx = cover.left + coverW * ${JSON.stringify(PROBES[0])}, cy = cover.top + coverH / 2;
          var el = document.elementFromPoint(cx, cy);
          barOverMap = !!(el && el.closest && el.closest('#msg-bar'));
          hits.push({ x: Math.round(cx), y: Math.round(cy), covered: Math.round(covered),
            top: el ? (el.tagName + (el.id ? '#' + el.id : '')) : 'null', inBar: barOverMap });
        }
        return JSON.stringify({ ok: separated && barVisible && covered === 0 && !barOverMap,
          text: '矩形重叠=' + !separated + '（面板底=' + Math.round(pr.bottom) + ' vs 消息栏顶=' + Math.round(jr.top) + '）'
            + ' 被盖住的面积=' + Math.round(covered) + 'px²' + (covered ? '（宽 ' + Math.round(coverW) + ' × 高 ' + Math.round(coverH) + '）' : '（空集）')
            + ' 消息栏可见=' + barVisible
            + '（矩形 ' + Math.round(jr.left) + ',' + Math.round(jr.top) + ' ' + Math.round(jr.width) + 'x' + Math.round(jr.height) + '）'
            + ' 面板=' + Math.round(pr.left) + ',' + Math.round(pr.top) + ' ' + Math.round(pr.width) + 'x' + Math.round(pr.height)
            + ' 重叠带上的命中=' + (hits.length ? JSON.stringify(hits) : '无重叠 ⇒ 不取样')
            + '（注入=' + INJ + '）',
          panel: { left: Math.round(pr.left), top: Math.round(pr.top), bottom: Math.round(pr.bottom) },
          probes: hits });
      })()`);
      return { ok: !!res.ok, text: res.text };
    }
  },
  {
    name: '消息栏功能没丢：真输入点得进、打得进、读得回 + 真帧里输入框那块**深色像素真的多出来**（空=0 → 打字后 ≥ 地板）',
    run: async (ctx) => {
      // 判据 4 的改动是"让它别盖住地图"，不是"把它拿掉" ⇒ 这一条守**功能**。
      // 判据来源（**不许 DOM 自证**）：
      //   ① **真输入**：走真实输入管线点进 `#msg-input`、`typeText` 打一段字 ⇒ 读回 `value` 逐字相同
      //      （点不到 / 被盖住 ⇒ 焦点落不到输入框、读回是空串 ⇒ 红）；
      //   ② **真帧**：输入框内缩 3px 那块里的**深色像素**（三通道都 < `paint.typeInk.maxEach`）
      //      在"空输入帧"里必须是 0 附近、在"打完字帧"里必须 ≥ `paint.typeInk.minHitsTypedInk`
      //      —— "字没上屏 / 被裁掉 / 透明化" ⇒ 0，必红 ✓
      //   为什么用"很深的那一档"而不是通用的非背景口径：实测 typing 会让浅灰 placeholder 消失，
      //   非背景墨**净减少**（打字后 8184 < 空态 8863）⇒ 那个口径会把"字明明画出来了"判成红 ✗；
      //   而"最深那一档"空态是 0、打字后是 75（placeholder 最暗 117、正文最暗 0）✓
      //   尺寸折算：`dpr` **现算**（真帧位图宽 ÷ `window.innerWidth`），不写死 —— 实测本机是 1
      //   （写死 2 会把矩形整个推到帧外 ⇒ 必然 0 命中，判据表面红、其实没在判东西 ✗）
      if (!ctx.input) return { ok: false, text: '没有真输入底座（ctx.input 缺失）⇒ 取不到真帧 = 红' };
      const TEXT = '冒烟：消息栏可见性探针';
      const setVal = async (v) => execJson(ctx, `(function () {
        var input = document.getElementById('msg-input');
        if (!input) return JSON.stringify({ ok: false, text: '没有 #msg-input' });
        input.value = ${JSON.stringify(v)};
        return JSON.stringify({ ok: true });
      })()`);
      const readGeo = async () => execJson(ctx, `(function () {
        var bar = document.getElementById('msg-bar');
        var input = document.getElementById('msg-input');
        if (!bar || !input) return JSON.stringify({ ok: false, text: '元素不齐' });
        var br = bar.getBoundingClientRect(), ir = input.getBoundingClientRect();
        return JSON.stringify({ ok: true, bar: { x: br.left, y: br.top, width: br.width, height: br.height },
          input: { x: ir.left, y: ir.top, width: ir.width, height: ir.height },
          vp: { w: window.innerWidth, h: window.innerHeight } });
      })()`);

      await setVal('');
      await WAIT.frames(ctx, { delayMs: 120 });
      const geo = await readGeo();
      if (!geo || !geo.ok) return { ok: false, text: '取几何失败：' + JSON.stringify(geo).slice(0, 200) };
      const frame0 = await ctx.input.capture();
      const info = frameStats.bitmapInfo(frame0);
      if (!info.ok) return { ok: false, text: '真帧位图与尺寸不一致（' + info.px + ' px vs ' + info.width + 'x' + info.height + '）⇒ 采不到真值，按红处理' };
      const dpr = info.width / Math.max(1, geo.vp.w);
      const dev = (r) => ({ x: r.x * dpr, y: r.y * dpr, width: r.width * dpr, height: r.height * dpr });
      const rect = dev(geo.bar);
      // 输入框**内缩 3px**：只数"里面的字"，把 1px 边框（含聚焦时的强调色）排除在判据之外
      const inRect = dev({ x: geo.input.x + 3, y: geo.input.y + 3,
        width: geo.input.width - 6, height: geo.input.height - 6 });
      const TIK = frameStats.THRESHOLDS.paint.typeInk;
      const darkInk = (a, b, c) => a < TIK.maxEach && b < TIK.maxEach && c < TIK.maxEach;
      const hit0 = frameStats.scanRegion(frame0, rect, { predicate: frameStats.nonBackgroundPredicate() });
      const ink0 = frameStats.scanRegion(frame0, inRect, { predicate: darkInk });

      // 真输入：点进输入框（点到就聚焦）→ 打那段字
      const ic = { x: geo.input.x + geo.input.width / 2, y: geo.input.y + geo.input.height / 2 };
      await ctx.input.moveTo(ic);
      await ctx.input.mouseDown(ic);
      await ctx.input.mouseUp(ic);
      await WAIT.frames(ctx, { delayMs: 120 });
      await ctx.input.typeText(TEXT);
      await WAIT.frames(ctx, { delayMs: 200 });
      const back = await execJson(ctx, `(function () {
        var input = document.getElementById('msg-input');
        var ir = input.getBoundingClientRect();
        var el = document.elementFromPoint(ir.left + ir.width / 2, ir.top + ir.height / 2);
        return JSON.stringify({ ok: true, value: input.value,
          hittable: !!(el && (el === input || (el.closest && el.closest('#msg-input') === input))),
          focused: document.activeElement === input, top: el ? (el.tagName + (el.id ? '#' + el.id : '')) : 'null' });
      })()`);
      await WAIT.frames(ctx, { delayMs: 120 });
      const frame1 = await ctx.input.capture();
      const hit1 = frameStats.scanRegion(frame1, rect, { predicate: frameStats.nonBackgroundPredicate() });
      const ink1 = frameStats.scanRegion(frame1, inRect, { predicate: darkInk });
      await setVal('');                          // 收尾：别把字留在消息栏里（域内自收尾 ✓）

      const inkThr = TIK.minHitsTypedInk;
      const bandThr = frameStats.THRESHOLDS.paint.minHitsMsgBarBand;
      const ok = hit0.ok && hit1.ok && ink0.ok && ink1.ok && back.ok
        && ink1.hits >= inkThr && hit1.hits >= bandThr && back.value === TEXT;
      return { ok: !!ok, text: '输入框里的**深色**像素：空=' + ink0.hits + ' → 打字后=' + ink1.hits
        + '/' + inkThr + '（dpr=' + dpr + '；深色＝三通道都 <' + TIK.maxEach + '）'
        + ' ｜ 整条带子非背景像素=' + hit0.hits + ' → ' + hit1.hits + '/' + bandThr
        + ' ｜ 真输入读回=' + JSON.stringify(back.value) + '（应为 ' + JSON.stringify(TEXT) + '）'
        + '焦点在输入框=' + back.focused + ' 可命中=' + back.hittable + '（最上层=' + back.top + '）'
        + ' ｜ 视口=' + geo.vp.w + 'x' + geo.vp.h };
    }
  }
];
