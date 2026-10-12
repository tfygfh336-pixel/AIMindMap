/* ============================================================
 * AI MindMap — 详情框里的两条热度条（人 / AI）+ 那次人类访问的采样
 * ------------------------------------------------------------
 * 本文件是**热度条第三件 · A 块**的渲染层部分。它做两件事，两件都**只碰展示与日志**：
 *
 *   ① **画两条热度条**（各十格 + 数值 + 窗口内样本量）；
 *   ② 记一次"人打开详情框"（裁决一里**唯一**算数的人类动作）。
 *
 * ## 铁律（改这个文件前先读）
 *   · **数据必须来自同一处**：每一个数字都来自 `desktop.app.heat` → 主进程 `heat --json`
 *     → `src/heat.js`。本文件**不许**自己算分位 / 名次 / 加权 —— 判据是一条机械搜索：
 *     渲染层里搜不到 `heat.js` 的权重表与名次映射键名（见 `tests/heat-bars.test.js` 的 A 段）。
 *   · **不许碰"正文只有一份"**：`dc.innerHTML = detail` 那一行（`app-detail-content.js`）
 *     仍是正文的**唯一**来源。热度条写在**另一个容器**（`.fd-heat`）里，一个字节都不进正文。
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
    host.appendChild(d);
  }

  /**
   * 把读数**逐字**翻成 DOM —— 一个数都不换算。
   * 数据形状（唯一来源 = `heat --json --node <id>` 的 `node` 字段，见 `cli/commands/heat.js`）：
   *   `{ heat, bands, rank, visits, listed, reason, who }` × 两侧 + `{sample:{nodes, events}}`。
   * ⚠️ `bands`（该亮几格）是**读数给的**，不是本文件按"档位占总格数的几分之几"算的 —— 判据是一条
   *    机械搜索：渲染层里不许出现任何档位换算（`tests/heat-bars.test.js` 的 C1 盯着，注释不算）。
   */
  function renderRow(host, side, row, note, nodeId) {
    const wrap = document.createElement('div');
    wrap.className = 'fd-heat-row fd-heat-band-' + side;
    // `data-*` 是给断言读的机器可读那一份（人读的是格子和数字，两者同源）
    wrap.setAttribute('data-side', side);
    // 这一行**属于哪个节点**：断言据此判"画出来的这份读数就是当前节点的"——
    // 只数"有没有两行"会读到上一位节点留下的那两行（实测踩到，判据因此假红）
    wrap.setAttribute('data-node', String(nodeId || ''));
    wrap.setAttribute('data-heat', String(row.heat));
    wrap.setAttribute('data-bands', String(row.bands));
    wrap.setAttribute('data-listed', row.listed ? '1' : '0');

    const who = document.createElement('span');
    who.className = 'fd-heat-who';
    who.textContent = side === 'human' ? '人' : 'AI';
    wrap.appendChild(who);

    const cells = document.createElement('span');
    cells.className = 'fd-heat-bands';
    for (let i = 0; i < row.bands; i++) {
      const c = document.createElement('span');
      c.className = 'fd-heat-cell on';
      cells.appendChild(c);
    }
    wrap.appendChild(cells);

    const val = document.createElement('span');
    val.className = 'fd-heat-val';
    // 数值一律写成 `档/档位总数（事件数）`（**逐字来自读数**）；没被访问过 ⇒ 明说"本窗口没被访问过"
    val.textContent = row.listed ? (row.heat + '/' + row.bandMax + '（' + row.visits + ' 次）') : '—';
    wrap.appendChild(val);

    const n = document.createElement('span');
    n.className = 'fd-heat-note';
    n.textContent = row.listed ? ('#' + row.rank) : note;
    wrap.appendChild(n);
    host.appendChild(wrap);
  }

  /**
   * 把一份 `heat --json --node <id>` 载荷画到某个框上。
   * @param {object} box 详情框（`MM.fdQ` 取容器）
   * @param {object} payload `heat --json` 的原始载荷
   */
  function paint(box, payload) {
    const host = MM.fdQ(box, '.fd-heat');
    if (!host) return null;
    lastPayload = payload;
    host.innerHTML = '';
    if (!payload) {
      // "正在取数"的占位（**不是**空条：空条会被读成"热度 0"）。见 refresh 里那次同步落笔。
      const d = document.createElement('div');
      d.className = 'fd-heat-note';
      d.textContent = '正在读取热度…';
      host.appendChild(d);
      return null;
    }
    const prof = payload.node ? payload.node : null;    // ← 读数就是形状，界面不折算
    if (!prof) { heatErr(box, '载荷里没有 node 读数（界面与 CLI 版本不匹配？）'); return null; }
    if (!payload.hasLog) {
      // "没有日志" ≠ "热度为 0"（口径照 CLI）：如实说"本机还没采到访问记录"
      const d = document.createElement('div');
      d.className = 'fd-heat-note';
      d.textContent = '本机还没有访问日志 —— 这**不等于**热度为 0（还没采到任何访问记录）';
      host.appendChild(d);
      return prof;
    }
    renderRow(host, 'human', prof.human, '本窗口未访问', prof.node);
    renderRow(host, 'ai', prof.ai, '本窗口未访问', prof.node);
    const s = document.createElement('div');
    s.className = 'fd-heat-note';
    // 样本量**如实暴露**：窗口内被访问过的节点数就是排名子集的大小（少样本时档位会跳）
    s.textContent = '窗口最近 ' + (prof.sample && prof.sample.windowDays) + ' 天'
      + ' · 被访问过的节点 ' + (prof.sample ? prof.sample.nodes : 0) + ' 个'
      + ' / 事件 ' + (prof.sample ? prof.sample.events : 0) + ' 条'
      + ' · 热度 = 在被访问过的节点里的**名次**十档（样本少时档位会跳）';
    host.appendChild(s);
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
