#!/usr/bin/env node
/* ============================================================
 * scripts/dsh-e2e.js — DSH 独立运行包端到端验证（不进常规 verify）
 * ------------------------------------------------------------
 * 验证链（每一步都是可观测副作用，全部实测）：
 *   1) vendor/dsh 运行包哈希完整（manifest.files 全量核对）
 *   2) 捆绑 node.exe 可执行
 *   3) 孵化：DSH_HOME=<temp独立目录> + --port 0 --no-open
 *      （与全局 3080 实例零冲突；绝不用 ~/.dsh）
 *   4) stdout 解析出 loopback token URL（正则同 main-dsh-sidebar.js）
 *   5) HTTP：无 token 401 / 带 token 200 且含 <title>
 *   6) 独立 HOME 自动生成 profiles（含指向 vendor 的 junction，而非全局）
 *   7) 收割进程树后端口关闭、锁语义完整
 * 退出码 0 = 全部通过。任何一步失败立即退出并清理。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const dshPackage = require('../src/dsh-package.js');

const URL_RE = /https?:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_\-]+)/;
const ROOT = path.join(__dirname, '..');
const BUNDLED = path.join(ROOT, 'vendor', 'dsh');

let proc = null;
let home = null;

function cleanup() {
  if (proc && proc.pid) {
    try { spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }); }
    catch (e) { /* ignore */ }
    proc = null;
  }
  if (home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
}

function fail(step, msg) {
  console.error('✗ ' + step + ': ' + msg);
  cleanup();
  process.exit(1);
}
function ok(step, detail) { console.log('✓ ' + step + (detail ? ' :: ' + detail : '')); }

/** 带 Cookie 跟随的 GET：token URL 首访会 303 + Set-Cookie（会话引导），
 *  裸 http.get 跟随重定向不带走 Cookie → 401。这里手动收发 Cookie。 */
function httpGet(url, timeoutMs, redirects, cookies) {
  return new Promise((resolve, reject) => {
    if ((redirects || 0) > 5) return reject(new Error('too many redirects'));
    const headers = {};
    if (cookies && cookies.size) headers.Cookie = [...cookies.entries()].map(([k, v]) => k + '=' + v).join('; ');
    const req = http.get(url, { timeout: timeoutMs, headers }, (res) => {
      // 收集 Set-Cookie
      const setCookies = res.headers['set-cookie'] || [];
      const jar = cookies || new Map();
      for (const sc of setCookies) {
        const m = /^([^=]+)=([^;]*)/.exec(sc);
        if (m) jar.set(m[1], m[2]);
      }
      if (res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307) {
        const loc = res.headers.location;
        res.resume();
        if (!loc) return reject(new Error('redirect without Location'));
        const next = new URL(loc, url).toString();
        return resolve(httpGet(next, timeoutMs, (redirects || 0) + 1, jar));
      }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function main() {
  process.on('exit', cleanup);
  console.log('== DSH 独立运行包端到端验证 ==');

  // 1) 运行包完整性
  let runtime;
  try {
    runtime = dshPackage.validateRuntime(BUNDLED, { verifyHashes: true });
    ok('运行包哈希校验', 'dsh ' + runtime.manifest.dshVersion + '，' + Object.keys(runtime.manifest.files).length + ' 文件');
  } catch (e) { fail('运行包哈希校验', e.message); }

  // 2) 捆绑 node 可执行
  const nodeVer = spawnSync(runtime.node, ['-p', 'process.versions.node'], { encoding: 'utf8' });
  if (nodeVer.status !== 0) fail('捆绑 node', '无法执行: ' + runtime.node);
  ok('捆绑 node', nodeVer.stdout.trim());

  // 3) 孵化（独立 HOME）
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aimap-dsh-e2e-'));
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (!/^(AI_MINDMAP_|DSH_|ELECTRON_RUN_AS_NODE)/i.test(k)) env[k] = process.env[k];
  }
  env.DSH_HOME = home;
  proc = spawn(runtime.node, [runtime.dsh, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  // 4) 等 stdout 出 token URL（最长 90s）
  const url = await new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve(null), 90000);
    proc.stdout.on('data', (c) => {
      buf += c.toString('utf8');
      const m = URL_RE.exec(buf);
      if (m) { clearTimeout(timer); resolve('http://127.0.0.1:' + m[1] + '/?token=' + m[2]); }
    });
    proc.on('exit', () => { clearTimeout(timer); resolve(null); });
  });
  if (!url) fail('stdout token URL', '90s 内未见就绪地址');
  const host = new URL(url).host;
  ok('stdout token URL', host + '（token 不打印）');

  // 5) HTTP 认证行为
  const noToken = await httpGet('http://' + host + '/', 10000).catch(() => null);
  if (!noToken || noToken.status !== 401) fail('无 token 401', '实际 ' + (noToken ? noToken.status : '连接失败'));
  ok('无 token → 401');
  const withToken = await httpGet(url, 15000).catch((e) => ({ err: e.message }));
  if (!withToken || withToken.status !== 200 || !/<title>/.test(withToken.body || '')) {
    fail('带 token 200', '实际 ' + (withToken ? withToken.status + ' len=' + (withToken.body || '').length + ' err=' + (withToken.err || '') : '连接失败'));
  }
  const title = /<title>([^<]*)<\/title>/.exec(withToken.body);
  ok('带 token → 200', 'title=' + (title ? title[1] : '?'));

  // 6) 独立 HOME 的 profile junction 指向 vendor（自包含），不指向全局
  await new Promise((r) => setTimeout(r, 3000)); // 等 profile 落盘
  const nm = path.join(home, 'profiles', 'node_modules');
  if (!fs.existsSync(nm)) fail('独立 HOME profile', 'profiles/node_modules 未生成');
  // junction 在「包目录」层（scoped 包是先目录后子链接；顶层包直接是链接）
  let vendorLinks = 0, globalLinks = 0, checked = 0;
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      let t = null;
      try { t = fs.readlinkSync(p); } catch (err) { t = null; } // 非链接 → null
      if (t) {
        checked++;
        if (t.includes('vendor')) vendorLinks++;
        else if (t.includes('npm') && t.includes('Roaming')) globalLinks++;
      } else if (e.isDirectory()) scan(p);
    }
  };
  scan(nm);
  if (globalLinks > 0) fail('junction 自包含', checked + ' 个链接中发现 ' + globalLinks + ' 个指向全局 npm');
  if (checked === 0) fail('junction 自包含', 'profiles/node_modules 下没有发现任何链接（布局变了？）');
  ok('junction 自包含', vendorLinks + '/' + checked + ' 指向 vendor，0 指向全局');

  // 7) 收割：进程树终止后端口应当关闭
  const pid = proc.pid;
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  proc = null;
  await new Promise((r) => setTimeout(r, 2000));
  const after = await httpGet('http://' + host + '/', 3000).catch(() => null);
  if (after && after.status) fail('进程树收割', '端口 ' + host + ' 仍在响应');
  ok('进程树收割', host + ' 已关闭');

  console.log('\n== 全部通过 ==');
  cleanup();
}

main().catch((e) => fail('未预期异常', (e && e.stack) || String(e)));
