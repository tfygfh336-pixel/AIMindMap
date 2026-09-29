#!/usr/bin/env electron
/* ============================================================
 * scripts/dsh-resident-host.js — 驻留生命周期的「一次性宿主进程」
 * ------------------------------------------------------------
 * 由 scripts/dsh-resident.js 分阶段调用（本文件不单独使用）：
 *   --phase=up     孵化服务 → 等 running → 正常退出（app.quit()，走 will-quit → destroy()）
 *   --phase=adopt  启动时**先接管**（adoptOrStart）→ 报告是否接管成功
 *   --phase=stop   先接管 → 再 stopService()（模拟菜单「停止 DSH 服务」）
 *
 * 为什么必须是独立进程：驻留语义的关键就在**进程边界**上 —— 同一个进程里
 * 调用 destroy() 什么也证明不了。这里用真实的 Electron 进程 + 真实的
 * main-dsh-sidebar.js，父脚本在两次宿主之间用 HTTP 与磁盘文件独立取证。
 *
 * 隔离：userData 指向临时目录（AI_MINDMAP_RESIDENT_UD），
 * 绝不碰真实 dsh-home / dsh-service.json / 运行锁。
 * ============================================================ */
'use strict';

const { app } = require('electron');

const ud = process.env.AI_MINDMAP_RESIDENT_UD;
if (!ud) { console.error('缺少 AI_MINDMAP_RESIDENT_UD（临时 userData 目录）'); process.exit(2); }
app.setPath('userData', ud);   // 必须在 require 侧栏模块**之前**（它经 app.getPath 取路径）

const dsh = require('../main-dsh-sidebar.js');

const phase = (() => {
  const a = process.argv.find((x) => x.indexOf('--phase=') === 0);
  return a ? a.slice('--phase='.length) : 'up';
})();

function report(obj) { process.stdout.write('RESIDENT_JSON:' + JSON.stringify(obj) + '\n'); }

/** 轮询到 running（或超时）*/
function waitRunning(timeoutMs) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    (function tick() {
      const s = dsh.getStatus();
      if (s.status === 'running') return resolve(s);
      if (s.status === 'error') return resolve(s);
      if (Date.now() - t0 > timeoutMs) return resolve(s);
      setTimeout(tick, 400);
    })();
  });
}

// 与 main.js 的 will-quit 行为一致：退出前走 destroy()（驻留语义在这里生效）
app.on('will-quit', () => dsh.destroy());

(async () => {
  await app.whenReady();

  if (phase === 'up') {
    dsh.startService();
  } else {
    await dsh.adoptOrStart();
  }

  const s = await waitRunning(90000);
  report({
    phase,
    status: s.status,
    servicePid: s.servicePid,
    ownedByThisWindow: s.ownedByThisWindow,
    resident: s.resident,
    error: s.error || null
  });

  if (phase === 'stop') {
    const victim = s.servicePid;
    dsh.stopService();
    // 收割是同步的（stopService 内 spawnSync taskkill），这里再确认一次死透，
    // 让父脚本的断言测的是"停止服务"本身，而不是"过一会儿也许会死"。
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      let alive = false;
      try { process.kill(victim, 0); alive = true; } catch (e) { alive = !!(e && e.code === 'EPERM'); }
      if (!alive) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    report({ phase: 'stop-verified', servicePid: victim });
  }

  // up / adopt 阶段：显式走一次完整的退出路径（will-quit → destroy）
  app.quit();
})();
