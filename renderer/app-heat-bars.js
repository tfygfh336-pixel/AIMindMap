/* ============================================================
 * AI MindMap — 详情框里的两条热度条（人 / AI）+ 那次人类访问的采样
 * ------------------------------------------------------------
 * 本文件是**热度条第三件 · A 块**的渲染层部分。它做两件事，两件都**只碰展示与日志**：
 *
 *   ① **画两条热度条**（2026-10-16 改版：**两颗很细的长横条** —— 底槽 + 按比例填充，
 *      位置在节点详情**标题框内**：节点名字右边、大小锁左边。用户原话："热度条只用两个很细的
 *      长横着的颜色条，类似游戏里面血条的效果，放在节点详情的'标题框'里面，也就是大小锁左边和
 *      节点名字右边。"）；
 *   ② 记一次"人打开详情框"（裁决一里**唯一**算数的人类动作）。
 *
 * ## 改版改了什么、**没改**什么（判据都钉在这两句上）
 *   改的：形态与位置 —— 从"标题框下面的正文区里两行「名字 + 十格 + 数值」"变成"标题框里
 *        两根 3px 的横条（底槽 + 填充）"。
 *   没改：**数值与颜色映射一个字节都没动** —— 填充比例仍是读数给的 `bands / bandMax`
 *        （`bands` 的定义就是"热度条要填几格"，那一次除法交给 CSS 的 `calc()` 算）；两个颜色仍是
 *        原来那两颗语义色（人 `#1664ff` / AI `#ff7d00`，见 `renderer/style.css`）；
 *        数值串（`档/档位总数（事件数）` · `#名次` · 窗口样本量那一句）**一个字都没改**，
 *        只是**不再印在标题框里**，改成**悬停才画出来**的自绘浮层 `.fd-heat-tip`
 *        （2026-10-16 用户追加要求："新热度条 UI 设计就不需要打印文字信息在旁边了，信息靠鼠标
 *        悬停在热度条上显示" ⇒ **条带上零文字**；浮层是**应用自绘**的，**不是**原生 `title`
 *        —— 原生弹窗是操作系统级的，无头截图/真帧里抓不到 ⇒ 证不出来 ✗）。
 *        渲染层仍是**一处实现**（`renderRow` + `attachTip`；空槽走 `renderEmptySlots`）。
 *
 * ## 铁律（改这个文件前先读）
 *   · **数据必须来自同一处**：每一个数字都来自 `desktop.app.heat` → 主进程 `heat --json`
 *     → `src/heat.js`。本文件**不许**自己算分位 / 名次 / 加权 —— 判据是一条机械搜索：
 *     渲染层里搜不到 `heat.js` 的权重表与名次映射键名（见 `tests/heat-bars.test.js` 的 A 段）。
 *     改版后**唯一的算术**是"分数 → 百分号"（`bandPercent`：`bands / bandMax`），
 *     它一个字节都没改比例（改版前是"亮 bands 格"，同一个分数、同一份读数）✓。
 *   · **不许碰"正文只有一份"**：`dc.innerHTML = detail` 那一行（`app-detail-content.js`）
 *     仍是正文的**唯一**来源。热度条写在**另一个容器**（`.fd-heat`，现在在标题框里），
 *     一个字节都不进正文。
 *   · **不许触发保存 / 写盘**：本文件不碰 `state.dirty`、不调 `desktop.project.save`、
 *     不改内存里的节点。它唯一的写动作是"往访问日志追加一行"（`app:visit` → `src/heat-sensor.js`），
 *     而那是**旁路产物**：不进项目 JSON、不产生未保存标记。用户只是看热度，不该留下任何写 ✓。
 *   · **打开不许变慢**：两条 IPC 都是异步、不 await（`refresh()` / `recordHumanOpen()` 都是
 *     fire-and-forget，DOM 已经画完了）。失败**响亮**：控制台一条 + 界面上一条可见提示（`.fd-heat-err`
 *     或状态栏）—— 不许静默（"没记上"与"记上了"必须可分辨）。
 *
 * ## 采样点（为什么在这里，而不是别处）
 *   `showDetail(node)` 是"打开详情框"这个动作的**唯一入口**（节点点击 / 搜索跳转 / 关联跳转 /
 *   命令面板 / 审计面板全都汇到它），所以在这里记一次 —— 一处采样点覆盖全部路径。
 *   ⚠️ **"只算打开这一次动作"的准确含义**：`showDetail` 被调用一次 = 记一次。
 *   对同一个节点的**重复**点击（或 `showDetailItem` 之类再次打开）会计数 —— 那是"用户又看了一眼"，
 *   本来就是一次访问（如实记，不做推断 —— 规格 §五的同一条精神）。
 *   而**框内的重绘**（`renderFdBox` / `refreshNodeDetailBox` / 条目选择）**不经** showDetail
 *   ⇒ 它们不会重复计数（这正是判据③"关掉/重开不重复计数"要区分的两件事）。
 * ============================================================ */
(function () {
  'use strict';
  const MM = window.MM || (window.MM = {});

  /** 人侧那一条通道名（通道权重表在 CLI 侧，本文件只认得这一个字符串） */
  const HUMAN_CHANNEL = 'human-detail';

  /** "正在取数"与"本机还没有访问日志"两句话：**逐字沿用改版前**那两句（它们从前在正文区可见）。
   *  现在：前者只作空槽的 `aria-label`，后者进**悬停浮层** —— 一个字都没改，只是不再印在标题框里 ✓ */
  const LOADING = '正在读取热度…';
  const NO_LOG = '本机还没有访问日志 —— 这**不等于**热度为 0（还没采到任何访问记录）';


  /** 顺序号：只认"最后一次请求"的结果（连点几个节点时，晚到的旧读数不许盖掉新的） */
  let seq = 0;
  /** 被丢弃的过期读数（诊断/断言用：它是"为什么界面显示的是旧值"的第一手证据） */
  let staleDropped = 0;
  /** 最近一次热度的**原始载荷**（读数自检 / 冒烟断言用；它是什么就存什么，不做加工） */
  let lastPayload = null;
  /** 最近一次采样结果（同上：失败要能被读出来） */
  let lastVisit = null;

  /**
   * 把一段"写入 DOM"的动作**按序**执行：只有当它是**最新**那一次请求时才会真的落笔。
   *
   * 为什么必须这样（这是本件实测抓到的一个**真缺陷**，不是测试的洁癖）：
   * 打开详情框会触发**不止一次**刷新（`showDetail` 的首次渲染 + `renderFdBox` 的重绘），
   * 每次都会重新取数。若后发起的那次先回来、先发起的那次后回来，后回来的**旧读数**
   * 就会盖掉新读数 —— 实测形状：界面上 AI 那条写着"未访问"，而 CLI 同一时刻读到 `10/10`，
   * 且**不会自愈**（没有下一次刷新来纠正它）。只靠"顺序号相等就丢弃"不够：
   * 被丢弃的那次**已经把容器清空了**，屏幕会停在半截状态。
   * 所以口径改成：**最新那次请求负责落笔，过期的一律不碰 DOM**（并记进 `staleDropped`）。
   */
  function commitIfLatest(write) {
    const mine = ++seq;
    return () => {
      if (mine !== seq) { staleDropped++; return false; }
      write();
      return true;
    };
  }

  function heatErr(box, msg) {
    const host = box && MM.fdQ ? MM.fdQ(box, '.fd-heat') : null;
    if (!host) return;
    host.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'fd-heat-err';
    d.textContent = '热度读不出来：' + String(msg).slice(0, 160);
    /* 标题框那一行只有 8px 高可用 ⇒ 可见的那一行会按 CSS 省略号截断（`.fd-heat-err`），
     * 完整报文同时挂 `title`（悬停可见）—— 两条路，**都不许静默** ✓ */
    host.setAttribute('title', d.textContent);
    host.appendChild(d);
  }

  /** 填充宽度：把读数给的两个数（`bands` / `bandMax`）**原样交给 CSS** 去做那一次比例 ——
   *  `calc()` 里那一次除法是**样式**算的，渲染层一个数都不算（本文件的老规矩：档位 / 名次 / 权重
   *  全在 CLI 侧；结构断言盯着"代码里不许有档位 ÷ 总格数这类换算"）。
   *  坏读数（缺字段 / `bandMax ≤ 0` / 非数）⇒ `0%`（画成空槽），**不猜** —— "采不到" ≠ "热度 0" ✓ */
  function fillWidth(row) {
    const max = Number(row && row.bandMax);
    const bands = Number(row && row.bands);
    if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(bands) || bands <= 0) return '0%';
    return 'calc(100% * ' + bands + ' / ' + max + ')';
  }

  /** 一条通道的"一句话读数"（**悬停浮层里那一串**：名字 + 数值 + 次数 + 名次） */
  function rowLine(side, row) {
    const who = side === 'human' ? '人' : 'AI';
    if (!row.listed) return who + '：本窗口未访问';
    return who + '：' + row.heat + '/' + row.bandMax + '（' + row.visits + ' 次） · 名次 #' + row.rank;
  }

  /** 窗口样本量那一句（**逐字沿用改版前**可见的那一串；现在只在悬停浮层里） */
  function sampleLine(prof) {
    const s = prof.sample || {};
    return '窗口最近 ' + s.windowDays + ' 天 · 被访问过的节点 ' + (s.nodes || 0) + ' 个'
      + ' / 事件 ' + (s.events || 0) + ' 条'
      + ' · 热度 = 在被访问过的节点里的**名次**十档（样本少时档位会跳）';
  }

  /** "还没取到读数"的那一行（**同一个 renderRow**，只是读数空着 —— 不是一个第二套实现 ✓）：
   *  `data-pending="1"` 让它与"真的是 `listed:false`（从没访问过）"**可分辨**（本工程的老规矩）。 */
  const EMPTY_ROW = { listed: false, heat: '', bands: '', bandMax: '', visits: '', rank: null };

  /** 悬停浮层（**应用内自绘**）：默认 `hidden`（不画一个像素），指针停在这一行上才显示。
   *  为什么不用原生 `title`：它是**操作系统级**弹窗，无头截图/真帧里根本抓不到 ⇒ 证不出来 ✗；
   *  自绘的这一层能被 `elementFromPoint` 命中、也能在真帧里数到像素 ✓（见冒烟域 40 的判据⑪）。
   *  ⚠️ 它挂在**行内**：这样"这一行的读数"与"这一行的文案"逐字同源，且单元测试 A1/A2 判的
   *  `row.textContent` 含数值那条 DOM 契约仍在（用户要的是"别把字**印**在标题框里"，不是"DOM 里不许有字"）✓ */
  function attachTip(wrap, text) {
    const box = document.createElement('div');
    box.className = 'fd-heat-tip';
    box.hidden = true;                      // 默认不画（真实 DOM 里 `hidden` 就是 `display:none`）
    box.textContent = text || '';
    wrap.appendChild(box);
    wrap.setAttribute('aria-label', text || '');   // 无障碍名字（不是"打印文字" ✓）
    /* 悬停开关：进这一行（含浮层自身）⇒ 显示；离开 ⇒ **立刻**藏起（不做延时 —— 见 CHANGELOG 的口径）。
     * 单测那套最小 DOM 桩没有 addEventListener ⇒ 有才挂（那一档只判 DOM 结构，不判悬停）。 */
    if (typeof wrap.addEventListener === 'function') {
      wrap.addEventListener('mouseenter', () => { box.hidden = false; });
      wrap.addEventListener('mouseleave', () => { box.hidden = true; });
    }
    return box;
  }

  /**
   * 写一行（= 一根很细的长横条）+ 它自己的悬停浮层。
   *
   * 形态：**底槽（track）+ 按比例填充（fill）**（游戏血条那一种），两条上下叠放、各 3px、间距 2px。
   * **条带上零文字**（用户 2026-10-16 追加要求）：条里只有底槽与填充两个元素；数值 / 口径 / 样本量
   * 全在那层**悬停才画出来**的 `.fd-heat-tip` 上 ✓。
   *
   * ⚠️ 宽度用 **`setAttribute('style', …)`** 写，不是 `fill.style.width = …`：单测那套最小 DOM 桩
   *    没有 `style` 对象，而它加载的是**本文件**（`tests/heat-bars.test.js` A1）⇒ 碰 `style` 会当场抛。
   */
  function renderRow(host, side, row, nodeId, tip, pending) {
    const wrap = document.createElement('div');
    wrap.className = 'fd-heat-row fd-heat-band-' + side;
    // `data-*` 是给断言读的机器可读那一份（人读的是条与悬停浮层，两者同源）
    wrap.setAttribute('data-side', side);
    // 这一行**属于哪个节点**：断言据此判"画出来的这份读数就是当前节点的"——
    // 只数"有没有两行"会读到上一位节点留下的那两行（实测踩到，判据因此假红）
    wrap.setAttribute('data-node', String(nodeId || ''));
    wrap.setAttribute('data-heat', String(row.heat));
    wrap.setAttribute('data-bands', String(row.bands));
    wrap.setAttribute('data-listed', row.listed ? '1' : '0');
    wrap.setAttribute('data-band-max', String(row.bandMax));   // 机器可读的那一份（比例的分母，逐字来自读数）
    if (pending) wrap.setAttribute('data-pending', '1');

    const track = document.createElement('span');
    track.className = 'fd-heat-track';
    const fill = document.createElement('span');
    fill.className = 'fd-heat-fill';
    fill.setAttribute('style', 'width:' + fillWidth(row));
    track.appendChild(fill);
    wrap.appendChild(track);

    attachTip(wrap, tip);
    host.appendChild(wrap);
  }

  /** 两颗**空槽**（"正在取数"那一档：版式立刻到位、又**不印任何字**）。
   *  刻意**不**建 `.fd-heat-row`：那一档还没有读数，建出来的行会被"数行数"的断言当成真读数
   *  （单元测试 A2 判 `rows.length === 2`，实测踩到过）✗ */
  function renderEmptySlots(host, nodeId) {
    ['human', 'ai'].forEach((side) => {
      const track = document.createElement('span');
      track.className = 'fd-heat-track fd-heat-band-' + side;
      track.setAttribute('data-heat-empty', side);
      track.setAttribute('data-node', String(nodeId || ''));
      track.setAttribute('aria-label', LOADING);     // 无障碍名字（不是"打印文字" ✓）
      const fill = document.createElement('span');
      fill.className = 'fd-heat-fill';
      fill.setAttribute('style', 'width:0%');
      track.appendChild(fill);
      host.appendChild(track);
    });
  }

  /**
   * 把一份 `heat --json --node <id>` 载荷画到某个框上（标题框里那两颗很细的长横条）。
   * 读数**逐字**翻成 DOM —— 一个数都不换算（比例那一次除法交给 CSS 的 `calc()`，见 `fillWidth`）。
   * @param {object} box 详情框（`MM.fdQ` 取容器）
   * @param {object} payload `heat --json` 的原始载荷；`null` = 正在取（两颗空槽）
   * @param {string} [nodeId] 这份读数/占位**属于哪个节点**（占位态也要带上，断言据此判归属）
   */
  function paint(box, payload, nodeId) {
    const host = MM.fdQ(box, '.fd-heat');
    if (!host) return null;
    lastPayload = payload;
    host.innerHTML = '';
    if (!payload) {
      /* "正在取数"这一档：两颗**空槽**、**零文字**、也没有浮层（下面 `data-pending` 那一档才有读数可讲）。
       * 与"没有热数据"的两档可分辨：① `!hasLog`（本机还没有访问日志）② 该通道没访问过（填充 0）——
       * 那两档都画**带浮层的空条**（悬停能读到"未访问 / 还没有访问日志"，不是一句印在框里的字）✓ */
      renderEmptySlots(host, nodeId);
      return null;
    }
    const prof = payload.node ? payload.node : null;    // ← 读数就是形状，界面不折算
    if (!prof) { heatErr(box, '载荷里没有 node 读数（界面与 CLI 版本不匹配？）'); return null; }
    const sample = sampleLine(prof);
    if (!payload.hasLog) {
      /* "没有日志" ≠ "热度为 0"：两颗条是空槽，**悬停**才说"本机还没采到访问记录"（一个字都没改）✓ */
      const tip = NO_LOG + ' ｜ ' + sample;
      renderRow(host, 'human', EMPTY_ROW, nodeId, tip, true);
      renderRow(host, 'ai', EMPTY_ROW, nodeId, tip, true);
      return prof;
    }
    /* 两个数（人 / AI）合成一句挂到**两根条各自的浮层**上：悬停哪一根都读得到**两个量的名字与数值**，
     * 但**自己那一侧写在最前面** ⇒ "悬停哪一根，就等于在问哪一个量"（文案随条切换，见冒烟判据⑪②）✓ */
    const lineH = rowLine('human', prof.human);
    const lineA = rowLine('ai', prof.ai);
    renderRow(host, 'human', prof.human, prof.node, lineH + ' ｜ ' + lineA + ' · ' + sample, false);
    renderRow(host, 'ai', prof.ai, prof.node, lineA + ' ｜ ' + lineH + ' · ' + sample, false);
    return prof;
  }

  function sameNode(box, node) {
    return !!(box && box.node && node && box.node.id === node.id);
  }

  /**
   * 刷新某个框上的热度条（**异步、不阻塞**：DOM 已经画好了，这里只是晚一步把数字补上）。
   * 失败 ⇒ 控制台一条 + 框里一条可见提示（两条都**响亮**，绝不静默）。
   */
  function refresh(box, node) {
    if (!box || !node || !node.id) return;
    const projectName = MM.state && MM.state.project ? MM.state.project.name : null;
    const host = MM.fdQ(box, '.fd-heat');
    if (!projectName) { heatErr(box, '还没有打开项目'); return; }
    if (!host) return;
    /* ⚠️ 落笔只在"最新那次请求"里发生（见 `commitIfLatest`）：清空容器这一步也必须在落笔里，
     * 否则"清空后就再没人落笔"会让屏幕停在半截状态（实测踩到过）。 */
    const commit = commitIfLatest(() => {
      host.innerHTML = '';
      paint(box, null, node.id);            // 先摆"正在取"的空态（不留下上一位节点的读数）
    });
    // 清空 + 占位：这一步**同步**做，但只有在这次是最新请求时才有意义 —— 所以走同一个闸门
    commit();
    const api = window.desktop && window.desktop.app;
    if (!api || !api.heat) { heatErr(box, '主进程没有提供 app.heat（界面与主进程版本不匹配）'); return; }
    // ⚠️ 带上 `node.id`：让 **CLI** 把这个节点的那一行直接端出来（名次/档位/样本量口径全在 src/heat.js），
    // 渲染层因此**没有任何"在榜里找它 / 算分位"的动作** —— 那是"界面显示的值与 CLI 逐字一致"的机械保证。
    api.heat(projectName, node.id).then((r) => {
      if (!sameNode(box, node)) return;               // 这个框已经换了节点 ⇒ 这批读数不属于它
      if (!r || r.ok !== true) {
        const msg = (r && r.error) || '未知原因';
        console.error('[heat] 读数失败：' + msg);
        commitIfLatest(() => heatErr(box, msg))();    // 失败也只在"最新"时落笔
        return;
      }
      commitIfLatest(() => { host.innerHTML = ''; paint(box, r.payload); })();
    }).catch((err) => {
      console.error('[heat] 读数异常：' + ((err && err.message) || err));
      commitIfLatest(() => heatErr(box, (err && err.message) || err))();
    });
  }

  /**
   * 记一次**人打开详情框**（裁决一的人类唯一访问动作）。
   * · 异步、不 await（打开详情的时序里它排在最后，绝不拖慢）；
   * · 失败**响亮**：控制台一条 + 状态栏一条（用户看得见），并把读数存进 `lastVisit`。
   * @returns {void} 返回值没有意义（调用方不需要等它）
   */
  function recordHumanOpen(node) {
    if (!node || !node.id) return;
    const projectName = MM.state && MM.state.project ? MM.state.project.name : null;
    const api = window.desktop && window.desktop.app;
    if (!projectName || !api || !api.visit) {
      lastVisit = { ok: false, reason: 'no-api', node: node.id };
      console.error('[heat] 没能记这次访问：界面拿不到 app.visit（项目未打开或主进程版本不匹配）');
      if (MM.setStatus) MM.setStatus('⚠ 这次“打开详情框”没能记进访问热度（主进程没提供记录通道）', true);
      return;
    }
    api.visit(projectName, node.id, HUMAN_CHANNEL).then((r) => {
      lastVisit = Object.assign({ node: node.id, channel: HUMAN_CHANNEL }, r || {});
      if (!r || r.ok !== true) {
        const msg = (r && r.error) || (r && r.errors && r.errors.join('；')) || ('原因 ' + ((r && r.reason) || '未知'));
        console.error('[heat] 访问没能记上：' + msg);
        if (MM.setStatus) MM.setStatus('⚠ 这次“打开详情框”没能记进访问热度：' + String(msg).slice(0, 120), true);
      }
    }).catch((err) => {
      const msg = (err && err.message) || String(err);
      lastVisit = { ok: false, reason: 'throw', error: msg, node: node.id, channel: HUMAN_CHANNEL };
      console.error('[heat] 记录访问时异常：' + msg);
      if (MM.setStatus) MM.setStatus('⚠ 这次“打开详情框”没能记进访问热度：' + msg.slice(0, 120), true);
    });
  }

  MM.heatBarsRefresh = refresh;
  MM.heatBarsRecordHumanOpen = recordHumanOpen;
  /** 读数（冒烟断言 / 排查用）：原始载荷 + 最近一次采样结果 + 被丢弃的过期读数条数
   *  （`staleDropped > 0` 说明确实发生过"两次刷新抢同一块饼"——那是本件修掉的那个竞态的现场证据）。 */
  MM.heatBarsState = () => ({ payload: lastPayload, visit: lastVisit, seq: seq, staleDropped: staleDropped });
})();
