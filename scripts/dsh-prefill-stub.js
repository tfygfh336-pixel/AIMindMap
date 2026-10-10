#!/usr/bin/env electron
/* ============================================================
 * scripts/dsh-prefill-stub.js —— 用**桩服务**走通 `prefillComposer` 的**成功分支**（D7）
 * ------------------------------------------------------------
 * 为什么要有它（这是本工程反复吃过的同一个坑）：
 *   `dsh-prefill`（把文本投喂进侧栏输入框）在**门禁里永远走的是失败路径** ——
 *   冒烟跑在 `setNoSpawn(true)` 下（不孵化也不接管服务），于是 `prefillComposer` 永远
 *   在 `state.status !== 'running'` 那一句返回；
 *   而"投喂成功"这半边（真的把字塞进页面输入框、真的派发 input/change 事件）**没有任何门禁覆盖**。
 *   ⇒ 成功路径一旦坏了（选择器跟 DSH 页面改版脱节、事件名写错、返回体形状变了），
 *     全链照旧全绿，只有用户在真机上才发现"点了投喂、输入框还是空的"。
 *
 * 这个脚本补上那半边：**起一个只回一段 HTML 的本地 HTTP 桩服务**（不孵化真 DSH、
 * 不碰任何真实数据），把它当侧栏页面加载进真正的 `WebContentsView`，
 * 然后调**真正的那份** `prefillComposer`：
 *   ① 返回值必须是 `{ok:true, tag:'TEXTAREA', …}`；
 *   ② 页面里的 textarea **真的收到了那段文本**（读 DOM 真值，不是信返回值）；
 *   ③ `input` / `change` 两个事件**真的被派发了**（页面自己记的计数器）。
 *   ⇒ 三条都过才算"投喂成功这条路能走通"。
 *
 * ⚠️ 它不是 `npm run verify` 的一部分（验证链里不跑它）：它是**按需跑的诊断/取证工具**，
 *    与 `dsh:e2e` / `dsh:resident` 同一类。跑法：`npm run dsh:prefill-stub`
 *    （或 `npx electron scripts/dsh-prefill-stub.js`）。
 * ⚠️ 隔离：`APPDATA` 指向临时目录（**绝不碰用户真实的 ~/.dsh 与 %APPDATA%/AI MindMap**）；
 *    桩服务只监听 127.0.0.1 的随机端口，跑完就关。
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// —— 隔离：必须在 require 侧栏模块**之前**把 userData 指到临时目录 ————————————————
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'aimap-prefill-stub-'));
const OLD_APPDATA = process.env.APPDATA;
process.env.APPDATA = SANDBOX;
process.env.AI_MINDMAP_PROJECTS_DIR = path.join(SANDBOX, 'projects');
fs.mkdirSync(process.env.AI_MINDMAP_PROJECTS_DIR, { recursive: true });

const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.join(SANDBOX, 'AI MindMap'));

/** 桩页面：一个 textarea + 两个事件计数器（**判据要读 DOM 真值，不能只信返回值**） */
const STUB_HTML = [
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title>stub composer</title></head><body>',
  '<textarea id="composer" style="width:90vw;height:60vh"></textarea>',
  '<script>',
  'window.__ev = { input: 0, change: 0 };',
  'var ta = document.getElementById("composer");',
  'ta.addEventListener("input", function () { window.__ev.input++; });',
  'ta.addEventListener("change", function () { window.__ev.change++; });',
  '</script></body></html>'
].join('\n');

const TEXT = '桩服务投喂验证：这段文字必须原样落进 textarea ✓';

let server = null;

function startStub() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(STUB_HTML);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve('http://127.0.0.1:' + port + '/');
    });
  });
}

function stopStub() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: !!ok, detail: String(detail == null ? '' : detail) });
}

async function main() {
  const url = await startStub();
  const sidebar = require('../main-dsh-sidebar.js');

  // ⚠️ 先把桩接上、**再** init：`init` 里有个 `setImmediate(adoptOrStart)`，它会（在 noSpawn 下）
  //    把状态清成 idle —— 先接桩能让它认出"已经有服务了"从而跳过（见 adoptOrStart 里的分支）。
  //    第一版先 init 再接桩 ⇒ 桩被那一步打回 idle ⇒ prefillComposer 永远走失败分支 ✗
  sidebar.setNoSpawn(true);      // 桩已经"在跑"了：不孵化、也不接管任何真实服务
  sidebar.__injectStubServiceForTest(url);

  // 侧栏 view 是挂在**主窗口**上的 WebContentsView ⇒ 必须有个窗口（离屏、不显示）
  const win = new BrowserWindow({ show: false, width: 1400, height: 900 });
  sidebar.init(win);
  sidebar.show();
  await new Promise((r) => setTimeout(r, 1500));   // 等页面加载完（桩是本地静态页，很快）

  const st = sidebar.getStatus();
  check('桩页面已进侧栏视图', st && st.hasView === true,
    JSON.stringify({ hasView: st && st.hasView, status: st && st.status }));

  // ★ 调**真正的那份** prefillComposer
  const r = await sidebar.prefillComposer(TEXT);
  check('prefillComposer 成功分支：返回 ok:true', r && r.ok === true, JSON.stringify(r));
  check('返回体形状：tag=TEXTAREA 且 textLen = 文本长度',
    !!r && r.tag === 'TEXTAREA' && r.textLen === TEXT.length,
    'tag=' + (r && r.tag) + ' textLen=' + (r && r.textLen) + ' 期望=' + TEXT.length);

  // ★ 判据读 DOM 真值（不信返回值）：文本真的在输入框里、两个事件真的派发了
  const view = sidebar.__viewForTest();
  check('桩脚本拿得到侧栏视图对象', !!view && !!view.webContents, 'view=' + !!view);
  let probeRaw = '';
  try {
    probeRaw = await view.webContents.executeJavaScript(
      'JSON.stringify({ url: location.href, hasTa: !!document.getElementById("composer"),'
      + ' value: (document.getElementById("composer") || {}).value || null, ev: window.__ev || null,'
      + ' bodyLen: (document.body ? document.body.innerHTML.length : -1) })'
    );
  } catch (e) {
    check('读桩页面 DOM 没抛异常', false, '抛了：' + ((e && e.message) || e));
  }
  let probe = null;
  try { probe = JSON.parse(probeRaw); } catch (e) { probe = null; }
  check('读到桩页面 DOM', !!probe, 'raw=' + String(probeRaw).slice(0, 200));
  if (probe) {
    check('★ DOM 真值：文本**真的**落在 textarea 里（不是只返回了 ok）',
      probe.value === TEXT, 'url=' + probe.url + ' hasTa=' + probe.hasTa
        + ' len=' + String(probe.value || '').length + ' 期望=' + TEXT.length
        + ' 完全一致=' + (probe.value === TEXT));
    check('★ 事件真的派发了：input 与 change 各至少一次',
      probe.ev && probe.ev.input >= 1 && probe.ev.change >= 1, JSON.stringify(probe.ev));
  }

  // 负例（成对判据）：空文本必须**响亮拒绝**，不能假装投喂成功
  const empty = await sidebar.prefillComposer('   ');
  check('负例：空文本 ⇒ ok:false 且给出原因（不静默成功）',
    !!empty && empty.ok === false && !!empty.reason, JSON.stringify(empty));

  // 清理
  try { sidebar.destroy(); } catch (e) { /* ignore */ }
  await stopStub();
  return results;
}

app.whenReady().then(async () => {
  let rs = [];
  try {
    rs = await main();
  } catch (err) {
    rs = [{ name: '脚本自身异常', ok: false, detail: (err && err.stack) || String(err) }];
  }
  let pass = 0;
  console.log('== dsh-prefill 桩服务：prefillComposer 成功路径 ==');
  rs.forEach((r) => {
    if (r.ok) pass++;
    console.log((r.ok ? '[PASS] ' : '[FAIL] ') + r.name + ' :: ' + r.detail);
  });
  console.log('==== ' + pass + '/' + rs.length + ' 通过 ====');
  console.log('（沙箱：' + SANDBOX + ' —— 真实 %APPDATA% 与 ~/.dsh 零触碰）');
  if (OLD_APPDATA !== undefined) process.env.APPDATA = OLD_APPDATA;
  app.exit(pass === rs.length ? 0 : 1);
});
