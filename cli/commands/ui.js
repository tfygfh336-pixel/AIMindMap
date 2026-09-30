/* ============================================================
 * cli/commands/ui.js —— 界面控制（给外部 AI / 内置 DSH 用）
 * ------------------------------------------------------------
 * `sidebar-only on`  = 关掉**左边思维导图页**，只留 DSH 侧栏（侧栏铺满窗口、对话继续可用）
 * `sidebar-only off` = 恢复导图页
 *
 * 为什么要有它：这个能力本来只在**应用菜单**里（人点），于是"外部 AI 迭代主界面代码"时，
 * 内置 DSH 明明想帮忙却没法自己把导图页让开。通道细节见 `src/control.js`。
 *
 * 硬口径：**没有回执 = 没生效**。主界面没在运行时，本命令**报错退出**（退出码非 0），
 * 绝不打印"已切换"就算完 —— 调用方是 AI，它会把静默成功当依据。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const control = require('../../src/control.js');

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

/** 等界面回执（轮询；界面每 400ms 扫一次命令，2.5s 足够，超时即判"没生效"） */
function waitForResult(baseDir, wantCmd, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = control.readResult(baseDir);
    if (r && r.cmd === wantCmd) return r;
    // 忙等一小会儿：本命令是人工/AI 一次性调用，不值得为它引入异步框架
    const t0 = Date.now();
    while (Date.now() - t0 < 100) { /* spin */ }
  }
  return null;
}

/** 两个方向的命令共用同一套"下命令 + 等回执 + 没回执就报错"的骨架 */
function driveUI(ctx, cmd, wantOn, msgs) {
  const dir = userDataDir();
  control.writeCommand(dir, { cmd: cmd, on: wantOn, at: new Date().toISOString(), by: 'cli' });
  const res = waitForResult(dir, cmd, 2500);
  if (!res || !res.ok) {
    ctx.error('主界面没有响应（' + dir + '）：请确认 AI MindMap 正在运行；'
      + '本命令只驱动**正在运行的**界面，不会自己去启动它');
  }
  if (ctx.args.json) {
    ctx.outJson({ ok: true, cmd: cmd, state: res.state, dir: dir });
    return;
  }
  ctx.out(wantOn ? msgs.on : msgs.off);
}

module.exports = {
  'sidebar-only'(ctx) {
    const mode = String((ctx.args._ && ctx.args._[0]) || '').toLowerCase();
    if (mode !== 'on' && mode !== 'off') {
      ctx.error('用法：sidebar-only <on|off>   on = 只留 DSH 侧栏（关掉左边思维导图页）；off = 恢复导图页');
    }
    driveUI(ctx, 'dsh-only', mode === 'on', {
      on: '已切到「只留侧栏」：左边思维导图页已关闭，DSH 侧栏继续可用（要恢复：sidebar-only off）',
      off: '已恢复思维导图页'
    });
  },

  /** 反方向：保留主界面（思维导图），独立关/开侧栏 DSH。
   *  off 会把 DSH 服务一起停掉 —— 所以"只改 DSH 那一侧"时不用重启整个应用 ✓。 */
  'dsh-sidebar'(ctx) {
    const mode = String((ctx.args._ && ctx.args._[0]) || '').toLowerCase();
    if (mode !== 'on' && mode !== 'off') {
      ctx.error('用法：dsh-sidebar <on|off>   on = 打开侧栏 DSH；off = 关掉侧栏 DSH（主界面继续用）');
    }
    driveUI(ctx, 'dsh-sidebar', mode === 'on', {
      on: '已打开侧栏 DSH（服务不在会自动重新孵化/接管）',
      off: '已关掉侧栏 DSH（含服务）；主界面与项目数据不受影响，要恢复：dsh-sidebar on'
    });
  }
};
