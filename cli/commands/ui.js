/* ============================================================
 * cli/commands/ui.js —— 界面控制（给外部 AI / 内置 DSH 用）
 * ------------------------------------------------------------
 * `sidebar-only on`  = 关掉**左边思维导图页**（**真卸载这一页**：主窗口只剩占位页）、只留 DSH 侧栏
 * `sidebar-only off` = 重新加载导图页（回到上次的项目与侧栏停靠宽度）
 *
 * 为什么要有它：这个能力本来只在**应用菜单**里（人点），于是"外部 AI 迭代主界面代码"时，
 * 内置 DSH 明明想帮忙却没法自己把导图页让开。通道细节见 `src/control.js`。
 *
 * 硬口径：**没有回执 = 没生效**。主界面没在运行时，本命令**报错退出**（退出码非 0），
 * 绝不打印"已切换"就算完 —— 调用方是 AI，它会把静默成功当依据。
 * ⚠️ 导图页有**未保存编辑**时，`on` 会被界面**拒绝**（报错里带原因）：那条路不弹模态框
 * （没人保证有人在看，弹窗会把调用方挂死 ✗）⇒ 先请人保存，或让人点界面上的 ✕。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const control = require('../../src/control.js');

/**
 * **慢命令的两步式执行骨架**：先探活，再下慢命令（纯逻辑；`probe`/`wait`/`send` 注入 ⇒ 单测零等待覆盖全部分支）。
 *
 * 为什么必须分两步（实测取证 2026-10-10 本机）：
 *   · 修前 `dsh-prefill` 只有一个 12s 窗口，界面**没在跑**时也要等满它 —— 实测 12.56s，
 *     而同批 `dsh-status` / `dsh-sidebar` / `sidebar-only` 都只需 ~3.0s（窗口 2.5s）。
 *     白等的原因很直接："没有回执"被同时当成了"也可能还在忙"。
 *   · 而 12s < app 侧最坏路径 12.4s（起服务 ≤6s + 窄宽加宽 0.4s + executeJavaScript ≤6s）
 *     ⇒ 界面**还在干活**时 CLI 就报"主界面没有响应…请确认在运行"，那是**假原因**。
 *   ⇒ 先用只读探针 `dsh-status` 问一句（当场可答、无慢路径）：
 *     没回执 ⇒ 界面确实没在跑 ⇒ **立刻**报错（~2.6s，与另三条命令同口径），且**不发出**慢命令；
 *     有回执 ⇒ 界面活着 ⇒ 下慢命令，并给足 PREFILL_MS（> app 侧最坏路径）。
 *
 * 边界（如实写）：探活与下慢命令之间界面可能刚好退出 ⇒ 那时会白等一个 PREFILL_MS 才报
 * "界面在运行但没有回执"。这是有意的取舍：宁可慢一次，也不把"没干活"说成"干完了"。
 *
 * ⚠️ `probe` / `send` 收的是**一个 token**：`probe(token)` 发出只读探针命令（写 pending/<token>.json），
 *   `send(token)` 发出慢命令。**回执按 token 认**（多槽协议，见 src/control.js）——
 *   于是"两个 CLI 进程同时下命令"不会互相覆盖，也不会互相吃到对方的回执 ✓。
 *
 * @param {(token:string)=>void} probe 发出**只读探针**命令
 * @param {(dir:string, token:string, ms:number)=>object|null} wait 等一拍回执（按 token）
 * @param {(token:string)=>void} send 发出**慢命令**（探活通过后才调用）
 * @returns {{receipt:object|null, phase:'final'|'not-running'|'no-receipt', token:string}}
 */
function runAfterLivenessProbe(probe, wait, send, dir, probeCmd, cmd, timeoutMs) {
  const token = control.newToken(cmd);
  if (probeCmd) {
    probe(token);
    const alive = wait(dir, token, UI_ACK_MS);
    if (!alive) return { receipt: null, phase: 'not-running', token: token };
  }
  send(token);
  const receipt = wait(dir, token, timeoutMs || PREFILL_MS);
  return receipt
    ? { receipt: receipt, phase: 'final', token: token }
    : { receipt: null, phase: 'no-receipt', token: token };
}

/** 探活窗口：与另三条命令同一口径（2.5s）—— 只读探针没有慢路径，界面没在跑时它必然落空。 */
const UI_ACK_MS = 2500;
/** 慢命令（dsh-prefill）的窗口：覆盖 app 侧最坏路径 ≈12.4s（起服务 ≤6s + 窄宽加宽 0.4s +
 *  `executeJavaScript` 超时 6s），留一点余量。**比旧值 12s 更大**是有意的：旧值会在界面还在干活时
 *  就宣布"没响应"（假原因）。这一窗口现在只会在"探活成功、界面却迟迟不回"时被走满。 */
const PREFILL_MS = 14000;

/** 应用 userData 目录：与主进程同规则。
 *  ⚠️ 实测踩坑：**不是** package.json 的 `name`（`ai-mind-map`），而是 Electron 的
 *  `app.getName()` ⇒ 本机真实目录是 `%APPDATA%\AI MindMap`（带空格、大写）。
 *  按 name 推会写到 `%APPDATA%\ai-mind-map`，界面永远看不到 —— 命令"看起来成功、实则没生效" ✗。
 *  所以这里按**候选顺序探测**：谁存在且里面有 dsh-home / dsh-service.json 就用谁。 */
function userDataDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const candidates = ['AI MindMap', 'ai-mind-map'];
  const exists = (d) => { try { return fs.statSync(d).isDirectory(); } catch (err) { return false; } };
  for (const name of candidates) {
    const dir = path.join(appData, name);
    if (exists(path.join(dir, 'dsh-home')) || exists(path.join(dir, 'dsh-service.json'))) return dir;
  }
  return path.join(appData, candidates[0]);   // 都没建过：按主进程默认名给一个
}

/**
 * 等回执（轮询；界面每 400ms 扫一次命令，2.5s 足够，超时即判"没生效"）。
 *
 * ⚠️ **只认自己那个 token**（多槽协议）：旧实现按 `<cmd>` 名认回执 —— 单槽时够用，
 *   多槽之后两条**同名**命令并发时会互相吃到对方的回执（那就是"至少一个拿到错回执" ✗）。
 *   token 由 `newToken()` 生成（pid + 时间 + 随机），并发安全 ✓
 *
 * @param {string} token 本次调用生成的命令序号
 * @param {number} timeoutMs 本次等待窗口（见 UI_ACK_MS / PREFILL_MS）
 */
function waitForResult(baseDir, token, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = control.readResult(baseDir, token);
    // ⚠️ 回执必须**新鲜** ✗ —— 本机真实事故：应用**没在运行**时，目录里留着的 4.5 小时前的旧回执
    //    被当成实时结果 ⇒ `dsh-status` 报 "running"、界面其实早关了 ✗✓（工程最忌的"假绿"）。
    //    判据：回执自带的 `at` 必须落在**本次等待窗口**内 ✓
    const at = r && r.at ? Date.parse(r.at) : NaN;
    const fresh = Number.isFinite(at) && at >= Date.now() - timeoutMs - 3000;
    if (r && r.token === token && fresh) {
      // 读走即清理（回执留在盘上只会变成下次的"陈旧回执"素材）
      try { control.clear(baseDir, token); } catch (e) { /* 清不掉不影响本次结论 */ }
      return r;
    }
    // 忙等一小会儿：本命令是人工/AI 一次性调用，不值得为它引入异步框架
    const t0 = Date.now();
    while (Date.now() - t0 < 100) { /* spin */ }
  }
  return null;
}

/** 两个方向的命令共用同一套"下命令 + 等回执 + 没回执就报错"的骨架 */
function driveUI(ctx, cmd, wantOn, msgs) {
  const dir = userDataDir();
  const token = control.newToken(cmd);
  control.writeCommand(dir, { cmd: cmd, on: wantOn, token: token, at: new Date().toISOString(), by: 'cli' });
  const res = waitForResult(dir, token, UI_ACK_MS);
  if (!res || !res.ok) {
    // 两种失败必须分清（否则用户拿到的建议是错的 ✗）：
    //   · **界面拒绝了**（有回执、带原因，如"有未保存编辑"）⇒ 照实转述那个原因；
    //   · **界面没响应**（压根没回执）⇒ 才说"请确认 AI MindMap 正在运行"。
    if (res && res.err) ctx.error('界面拒绝了这条命令：' + res.err);
    ctx.error('主界面没有响应（' + dir + '）：请确认 AI MindMap 正在运行；'
      + '本命令只驱动**正在运行的**界面，不会自己去启动它');
  }
  if (ctx.args.json) {
    ctx.outJson({ ok: true, cmd: cmd, state: res.state, token: token, dir: dir });
    return;
  }
  ctx.out(wantOn ? msgs.on : msgs.off);
}

module.exports = {
  'sidebar-only'(ctx) {
    const mode = String((ctx.args._ && ctx.args._[0]) || '').toLowerCase();
    if (mode !== 'on' && mode !== 'off') {
      ctx.error('用法：sidebar-only <on|off>   on = 关掉左边思维导图页（**真卸载这一页**，只留 DSH 侧栏）；'
        + 'off = 重新加载导图页（回到上次的项目）');
    }
    driveUI(ctx, 'dsh-only', mode === 'on', {
      on: '已关掉导图页（**真卸载这一页**：它的内存已释放，主窗口只剩占位页）；'
        + 'DSH 侧栏继续可用（要恢复：sidebar-only off —— 会重新加载导图页）',
      off: '已重新加载导图页（回到上次的项目与侧栏停靠宽度）'
    });
  },

  /** 反方向：保留主界面（思维导图），独立关/开侧栏 DSH。
   *  off 会把 DSH 服务一起停掉、并**销毁**侧栏那个视图 ⇒ 所以"只改 DSH 那一侧"时不用重启整个应用 ✓ */
  'dsh-sidebar'(ctx) {
    const mode = String((ctx.args._ && ctx.args._[0]) || '').toLowerCase();
    if (mode !== 'on' && mode !== 'off') {
      ctx.error('用法：dsh-sidebar <on|off>   on = 打开侧栏 DSH；off = 关掉侧栏 DSH（主界面继续用）');
    }
    driveUI(ctx, 'dsh-sidebar', mode === 'on', {
      on: '已打开侧栏 DSH（服务不在会自动重新孵化/接管；视图会重新加载）',
      off: '已关掉侧栏 DSH（含服务，视图已销毁）；主界面与项目数据不受影响，要恢复：dsh-sidebar on'
    });
  },

  /** ⑩ 把一段文本送进侧栏的输入框（**不代替你发送** ✗ —— 那边按了发送才进它的会话历史 ✓）。
   *  用法：`dsh-prefill "要送过去的文本"`；也支持 `--file <路径>` 从文件读（长对话用）。
   *  等**回执**才报成功 ✓（没有回执 = 没生效 ✗）。
   *
   *  ⚠️ 它是**慢命令**（要先把侧栏服务起起来，app 侧最坏 ≈12.4s），故走"先探活、再下命令"两步
   *  ——为什么、以及修前的实测数字（12.56s vs 另三条 ~3.0s）见 `runAfterLivenessProbe` 的注释。 */
  'dsh-prefill'(ctx) {
    // ⚠️ 位置参数从 `_[0]` 起（命令名不在里面 ✓ —— 隔壁 dsh-sidebar 用的就是 _[0] ✓）
    let text = String((ctx.args._ && ctx.args._[0]) || '');
    if (ctx.args.file) {
      try { text = require('fs').readFileSync(String(ctx.args.file), 'utf8'); } catch (e) { ctx.error('读不到文件：' + String(ctx.args.file) + '（' + ((e && e.message) || e) + '）'); }
    }
    if (!text.trim()) ctx.error('用法：dsh-prefill "<文本>" 或 dsh-prefill --file <路径>（以 - 开头时用 --file）');
    const dir = userDataDir();
    // ① 先发**只读探针**（dsh-status）并等回执：它当场可答、没有慢路径
    // ② 探活通过才把文本发出去（dsh-prefill），并给足 PREFILL_MS
    //    ⚠️ 探针与慢命令**共用同一个 token**（同一个调用方、同一个等待位）—— 于是"探活的回执"
    //       与"慢命令的回执"不会互相串（旧实现按 cmd 名认，两条同名命令并发时会串 ✗）。
    const r = runAfterLivenessProbe(
      (token) => { control.writeCommand(dir, { cmd: 'dsh-status', token: token, at: new Date().toISOString(), by: 'cli' }); },
      waitForResult,
      (token) => {
        control.writeCommand(dir, { cmd: 'dsh-prefill', text: text, token: token, at: new Date().toISOString(), by: 'cli' });
      },
      dir, 'dsh-status', 'dsh-prefill', PREFILL_MS);
    if (r.phase === 'not-running') {
      // 依据是**只读探针 dsh-status 也没有回执** ⇒ "没在运行"这句是有证据的，不是推断
      ctx.error('主界面没有响应（' + dir + '）：确认 AI MindMap 正在运行、且侧栏已打开；'
        + '本命令只驱动**正在运行的**界面，不会自己去启动它（只读探针 dsh-status 同样没有回执）');
    }
    if (r.phase === 'no-receipt') {
      ctx.error('界面在运行（探针有回执），但 ' + Math.round(PREFILL_MS / 1000) + 's 内没送回结果（' + dir + '）：'
        + '侧栏可能还在起服务、或页面没加载完 —— 到侧栏看一眼，或用 `node cli/mm-cli.js dsh-status` 查实况');
    }
    const res = r.receipt;
    // 上面两种失败都走 ctx.error（抛错）⇒ 到这里必须有终局回执；万一将来 error 不再抛错，
    // 也必须**响亮**失败，而不是去读一个 null（那就成了本工程最忌的"静默通过"）
    if (!res) throw new Error('内部错误：等待回执返回了空结果（phase=' + r.phase + '）');
    if (!res.ok) ctx.error('没有送进侧栏：' + (res.err || '未知原因'));
    if (ctx.args.json) { ctx.outJson({ ok: true, token: r.token, result: res.result || null }); return; }
    ctx.out('已送进侧栏输入框：' + ((res.result && res.result.textLen) || text.length) + ' 字（'
      + ((res.result && res.result.tag) || '?') + '）—— 到侧栏按发送即可 ✓');
  },

  /**
   * **只读**诊断：读侧栏实况（可见性 / 总占宽 / 窄宽模式 / 是否横向溢出）。
   * 为什么需要：窄宽适配（③）的效果以前只能靠肉眼看 ✗ —— 改布局不能拍脑袋，
   * 要有数字。本命令不改任何状态，随便调 ✓。输出**不含 url/token** ✓。
   * 窗口沿用第一段口径（2.5s）：它是**只读且当场可答**的，没有"起服务"这种慢路径。 */
  'dsh-status'(ctx) {
    const dir = userDataDir();
    const token = control.newToken('dsh-status');
    control.writeCommand(dir, { cmd: 'dsh-status', token: token, at: new Date().toISOString(), by: 'cli' });
    const res = waitForResult(dir, token, UI_ACK_MS);
    if (!res || !res.ok || !res.status) {
      ctx.error('主界面没有响应或读不到状态（' + dir + '）：请确认 AI MindMap 正在运行');
    }
    const s = res.status;
    if (ctx.args.json) { ctx.outJson(s); return; }
    ctx.out('侧栏状态: ' + s.status + (s.visible ? '（可见）' : '（已收起）'));
    // 「真关」的两个判据（v0.19）：侧栏视图在不在、导图页是不是已经被卸载
    ctx.out('侧栏视图: ' + (s.hasView ? ('在（第 ' + s.viewEpoch + ' 次创建，webContents ' + s.viewId + '）')
      : '**已销毁**（关侧栏会销毁它；重开会重建并重新加载页面）'));
    ctx.out('导图页: ' + (s.mapPageClosed ? '**已关闭/已卸载**（真关，重开：sidebar-only off）' : '打开着')
      + '｜上次项目 ' + (s.lastProject || '（未记）'));
    ctx.out('宽度: 意图 ' + s.width + ' / 实际占宽 ' + s.actualWidth + '（控制栏 + 内容）');
    if (s.narrow) {
      ctx.out('窄宽适配: 模式 ' + s.narrow.mode + '，内容宽 ' + s.narrow.viewWidth
        + (s.narrow.metrics
          ? '，页面 ' + s.narrow.metrics.innerWidth + 'px / 内容 ' + s.narrow.metrics.scrollWidth
            + 'px ⇒ ' + (s.narrow.metrics.overflow ? '**横向溢出**' : '不溢出')
          : '（未取到页面度量：' + (s.narrow.err || '?') + '）'));
    } else {
      ctx.out('窄宽适配: 尚未注入（原因: ' + (s.narrowSkip || '未调度') + '）');
    }
    // 内核右栏 ⇄ 自动加宽（用户要求：点开右栏自动加宽侧栏、关掉还原）
    ctx.out('内核右栏: ' + (s.rightbarOpen ? '开着' : '关着')
      + '｜观察器 ' + (s.rightbarWatcher || '未装')
      + '｜自动加宽 ' + (s.autoWide ? ('生效中（原宽度 ' + s.autoWide.prev + '，现 ' + s.actualWidth + '）') : '未生效'));
    // 测量驱动的**内容预算**（2026-10-16 批）：档位 + 区间 + 走到上界仍装不下时的**如实上报**。
    // 这一行是给"我明明拖宽了它还是不显示"准备的：装不下不再是静默的 ✗
    if (s.contentBudget) {
      const b = s.contentBudget;
      ctx.out('内容预算: ' + b.tier + '（带宽区间 ' + b.min + '…' + b.max + '（含控制栏），步进 ' + b.step
        + '，已加 ' + b.stepUps + ' 步，回退点 ' + b.prev + '）'
        + (b.overflowAtCeiling ? '｜**内容仍装不下：已到宽度上限**' : '')
        + (b.note ? '｜' + b.note : ''));
    }
  },

  // ---- 供单测直接钉住等待逻辑（不是命令；见 tests/dsh-prefill-wait.test.js）----
  // 导出的是**纯判定骨架 + 两个窗口常量**：这样"探活失败/成功后超时/正常拿到结果"全部分支
  // 能在**零等待**下被覆盖，而窗口常量本身成为可断言的契约（必须覆盖 app 侧最坏路径）。
  __waitForResult: waitForResult,
  __runAfterLivenessProbe: runAfterLivenessProbe,
  __driveUI: driveUI,
  __UI_ACK_MS: UI_ACK_MS,
  __PREFILL_MS: PREFILL_MS,
  __userDataDir: userDataDir
};
