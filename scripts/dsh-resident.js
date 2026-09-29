#!/usr/bin/env node
/* ============================================================
 * scripts/dsh-resident.js — 驻留语义端到端验证（headless，不进常规 verify）
 * ------------------------------------------------------------
 * 验证的**正是 README 的对外承诺**：「重启/升级主界面时侧栏对话不中断，
 * 新主界面自动接管既有服务」。这条承诺在 v0.16.6 之前是**假的** ——
 * `destroy()` 在正常退出时会把服务 taskkill 掉，接管路径只在崩溃后才走到；
 * 而旧的门禁全都测不到它（冒烟不孵化服务；dsh:e2e 自建进程，不经过
 * main-dsh-sidebar.js 的任何一行）。这个脚本补上那段空白。
 *
 * 三个阶段、三次独立取证（每个断言都来自真实进程/HTTP/磁盘，不是日志推断）：
 *   1) up    —— 宿主 A 孵化服务后**正常退出**（app.quit → will-quit → destroy）
 *   2) 服务必须还活着：HTTP 200/303/401 有响应 + 进程 pid 仍在 + 凭据文件仍在
 *      + 运行锁的 pid **指向服务**（不是死掉的宿主 A）→ 维护互斥仍然成立
 *   3) adopt —— 宿主 B 启动 → 必须**接管**（ownedByThisWindow=false，pid 不变）
 *      ④ stop  —— 宿主 C 接管后执行 stopService（菜单「停止 DSH 服务」）→
 *      端口关闭 + 凭据/锁清干净 + 下次启动能重新孵化
 *
 * 退出码 0 = 全部通过。失败即清理并退出（绝不留下孤儿服务）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOST = path.join(__dirname, 'dsh-resident-host.js');
const ELECTRON = require('electron'); // 包导出的是 electron.exe 的绝对路径

const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'aimap-resident-ud-'));
let servicePid = null;

function ok(step, detail) { console.log('✓ ' + step + (detail ? ' :: ' + detail : '')); }
function fail(step, msg) { console.error('✗ ' + step + ': ' + msg); cleanup(); process.exit(1); }

function cleanup() {
  if (servicePid) {
    try { spawnSync('taskkill', ['/pid', String(servicePid), '/T', '/F'], { windowsHide: true }); } catch (e) { /* ignore */ }
    servicePid = null;
  }
  try { fs.rmSync(UD, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
process.on('exit', cleanup);

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

/** 起一个宿主进程并等它打印 RESIDENT_JSON（阶段结论）*/
function runHost(phase, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ELECTRON, [HOST, '--phase=' + phase], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { AI_MINDMAP_RESIDENT_UD: UD }),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => {
      try { proc.kill(); } catch (e) { /* ignore */ }
      reject(new Error('宿主 ' + phase + ' 超时（' + timeoutMs + 'ms）'));
    }, timeoutMs);
    proc.stdout.on('data', (c) => { out += c.toString('utf8'); });
    proc.stderr.on('data', (c) => { out += c.toString('utf8'); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      const m = /RESIDENT_JSON:(\{.*\})/.exec(out);
      if (!m) return reject(new Error('宿主 ' + phase + ' 未输出结论（exit=' + code + '）\n' + out.slice(-1500)));
      let json;
      try { json = JSON.parse(m[1]); } catch (e) { return reject(new Error('结论 JSON 解析失败: ' + m[1])); }
      resolve(json);
    });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function httpStatus(url, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = http.get({ host: u.hostname, port: u.port, path: '/' + u.search, timeout: timeoutMs },
        (res) => { res.resume(); resolve(res.statusCode); });
      req.on('timeout', () => { req.destroy(); resolve(0); });
      req.on('error', () => resolve(0));
    } catch (e) { resolve(0); }
  });
}

function readServiceInfo() {
  try { return JSON.parse(fs.readFileSync(path.join(UD, 'dsh-service.json'), 'utf8')); } catch (e) { return null; }
}
function readLock() {
  try { return JSON.parse(fs.readFileSync(path.join(UD, 'dsh-runtime.lock'), 'utf8')); } catch (e) { return null; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('== DSH 驻留语义端到端验证 ==');
  console.log('   （临时 userData: ' + UD + '；真实 dsh-home 零触碰）');

  // ---------- 1) 孵化后正常退出 ----------
  const a = await runHost('up', 150000).catch((e) => fail('宿主 A 孵化', e.message));
  if (a.status !== 'running') fail('宿主 A 孵化', 'status=' + a.status + ' error=' + a.error);
  servicePid = a.servicePid;
  if (!a.ownedByThisWindow) fail('宿主 A 孵化', 'ownedByThisWindow 应为 true（本进程孵化）');
  ok('宿主 A 孵化服务', 'pid=' + servicePid + '（ownedByThisWindow=true）');

  const info = readServiceInfo();
  if (!info || !info.url) fail('凭据落盘', 'dsh-service.json 缺 pid/url');
  // 宿主 A 已退出（runHost 等到了 exit），此刻服务必须自己活着
  if (!pidAlive(servicePid)) fail('宿主退出后服务存活', 'pid ' + servicePid + ' 已不在');
  const st = await httpStatus(info.url, 5000);
  if (!st) fail('宿主退出后服务存活', 'HTTP 无响应（服务随宿主一起死了 —— 驻留语义失效）');
  ok('宿主 A 正常退出后服务仍存活', 'pid=' + servicePid + ' HTTP=' + st);

  // ---------- 2) 运行锁指向服务（维护互斥仍成立）----------
  const lock = readLock();
  if (!lock) fail('运行锁跟服务走', '锁文件不见了（服务在跑却没有锁 → 维护会在活服务脚下换包）');
  if (lock.pid !== servicePid) {
    fail('运行锁跟服务走', '锁 pid=' + lock.pid + ' ≠ 服务 pid=' + servicePid
      + '（指向已死的宿主 → 会被当成陈旧锁接管）');
  }
  ok('运行锁指向服务进程', 'pid=' + lock.pid + ' holder=' + lock.holder + ' launcherPid=' + lock.launcherPid);

  // ---------- 3) 新宿主必须**接管**（不是重新孵化）----------
  const b = await runHost('adopt', 60000).catch((e) => fail('宿主 B 接管', e.message));
  if (b.status !== 'running') fail('宿主 B 接管', 'status=' + b.status + ' error=' + b.error);
  if (b.ownedByThisWindow) fail('宿主 B 接管', '又孵化了一个新服务（说明接管失败，对话会断）');
  if (b.servicePid !== servicePid) fail('宿主 B 接管', 'pid 变了：' + servicePid + ' → ' + b.servicePid);
  ok('新宿主接管既有服务', 'pid 不变=' + b.servicePid + '（ownedByThisWindow=false，零冷启动）');

  // 宿主 B 退出（adopt 阶段同样走 destroy）→ 服务还得活着
  if (!pidAlive(servicePid)) fail('第二次宿主退出后服务存活', 'pid ' + servicePid + ' 已不在');
  ok('第二个宿主退出后服务仍存活', 'pid=' + servicePid);

  // ---------- 4) 显式停止（菜单「停止 DSH 服务」）----------
  const c = await runHost('stop', 60000).catch((e) => fail('宿主 C 停止服务', e.message));
  if (c.status !== 'running') fail('宿主 C 接管', 'status=' + c.status + ' error=' + c.error);
  await sleep(2500); // 等 taskkill 落地
  if (pidAlive(servicePid)) fail('停止 DSH 服务', 'pid ' + servicePid + ' 仍在');
  const after = await httpStatus(info.url, 3000);
  if (after) fail('停止 DSH 服务', '端口仍在响应（HTTP=' + after + '）');
  if (readServiceInfo()) fail('停止 DSH 服务', 'dsh-service.json 未清（下次启动会去接管一个死服务）');
  if (readLock()) fail('停止 DSH 服务', '运行锁未清（留下假持有者挡维护）');
  ok('停止 DSH 服务', '进程已收割、端口关闭、凭据与运行锁均已清理');
  servicePid = null;

  console.log('\n== 全部通过（驻留语义成立：重启主界面不中断侧栏对话）==');
  cleanup();
})().catch((e) => fail('未预期异常', (e && e.stack) || String(e)));
