/* ============================================================
 * tests/cap-menu-ipc.test.js — 「剖面 ⇒ 原生菜单」那条 IPC 的**接线判据**
 * ------------------------------------------------------------
 * 治的是什么：这一批最容易做假的一件事 —— 只在 `main.js` 里写好处理函数，就宣布"已接"，
 *   而 `preload.js` 一行没改 ⇒ 渲染层根本发不出这条 IPC（接线断了一头，菜单永远不跟着变）。
 *   所以本文件把**两端**都钉住：发送端（preload 的 `desktop.app.capProfile`）与
 *   接收端（`main.js` 的 `ipcMain.on('app:capProfile')`），缺一头就红。
 *
 * 分工（别把 runtime 判据挪进这里）：
 *   · 本文件钉**代码形状**：这是静态判据，跑得快、能在 vitest 里跑；
 *   · **真的变了没有**（`MenuItem.enabled` 在切剖面后确实变 false / 恢复 true）由
 *     `.review/20261070-IPC与PNG与seq/` 的冒烟域 58 实跑读数钉着（真 IPC + 真菜单读回）。
 *
 * 判别力：`judge()` 是**纯函数**（输入是"相对路径 → 源码"），最后一条用例喂一份**故意违规**的
 *   假源码 ⇒ 同一个 judge 必须把每一条都报出来（否则前几条随时可能退化成空转）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 剖面名**不在这里手抄**：从 `src/diagram/profiles.js`（唯一权威）现取。
 *  手抄一份 = 给未来的自己安排一次漂移（矩阵改名那天，这里会继续绿着）。 */
const PROFILES = require('../src/diagram/profiles.js').PROFILES.slice();

const FILES = {
  'main.js': '',
  'preload.js': '',
  'renderer/app-core.js': '',
  'renderer/app.js': '',
  'renderer/index.html': ''
};
const realSources = () => {
  const out = {};
  Object.keys(FILES).forEach((rel) => { out[rel] = readFileSync(path.join(ROOT, rel), 'utf8'); });
  return out;
};

/** 只数**代码行**（注释里写通道名是文档，不是第二条实现） */
const codeLines = (text) => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

/** 数"某个剖面名作为字符串字面量"出现几次。
 *  ⚠️ 只有一个例外，而且必须点名：`path` 同时是 Node 内置模块名 —— `require('path')` 不是剖面。
 *     所以 `path` 这一档只排除**紧跟在 require( 或 getPath( 后面的**引号字面量；
 *     其余位置（`profile: 'path'` 这种）照样算剖面名（放宽成"看见 path 就跳过"等于把这条判据关掉）。 */
function countProfileLiterals(src, names) {
  const out = {};
  names.forEach((n) => {
    const re = new RegExp('[\'"`]' + n + '[\'"`]', 'g');
    let count = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (n === 'path') {
        const before = src.slice(Math.max(0, m.index - 12), m.index);
        if (/require\(\s*$/.test(before) || /getPath\(\s*$/.test(before)) continue;
      }
      count++;
    }
    out[n] = count;
  });
  return out;
}

/** 取一个具名函数的函数体（按括号配对；跳过参数表的括号 —— 与 export-png-single-path 同一手法） */
function fnBody(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) return null;
  let p = m.index + m[0].length - 1;
  let pd = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') pd++;
    else if (src[p] === ')') { pd--; if (pd === 0) break; }
  }
  const i = src.indexOf('{', p + 1);
  if (i < 0) return null;
  let depth = 0;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  return null;
}

/**
 * 判定本体（纯函数）。输入 = "相对路径 → 源码"，输出 = `{ ok, problems, readings }`。
 * 四条判据逐条对应本批的承诺：
 *   ① 发送端在渲染层能拿到：`preload.js` 里 **一处** `ipcRenderer.send('app:capProfile'`（下行，
 *      不是 invoke —— 主进程不需要回执，渲染层也不该等它）；
 *   ② 接收端在 `main.js` 里**恰一处** `ipcMain.on('app:capProfile'`，且回调里调了 `syncCapMenu()`
 *      （只 registered 不刷新 = 菜单永远不变，那是最会骗过眼睛的"接了但没生效"）；
 *   ③ 两条受能力管的菜单项走**运行时闸** `sendIfCap(...)`，旧的裸 `send('menu:expand-all')` 一处不剩；
 *   ④ 五份源码里剖面名字面量 **=== 0**；渲染层只有**一处**发送点、且那一处不在定时器里（事件驱动）。
 */
function judge(sources) {
  const problems = [];
  const readings = {};

  // ① 发送端
  const pre = codeLines(sources['preload.js'] || '').join('\n');
  const sends = (pre.match(/ipcRenderer\.send\(\s*'app:capProfile'/g) || []).length;
  const invokes = (pre.match(/ipcRenderer\.invoke\(\s*'app:capProfile'/g) || []).length;
  readings.preloadSend = sends;
  readings.preloadInvoke = invokes;
  if (sends !== 1) problems.push('preload.js 里 `ipcRenderer.send(\'app:capProfile\'` 出现 ' + sends + ' 次（必须恰好 1 次）—— 渲染层发不出去，菜单永远不会跟着剖面变');
  if (invokes !== 0) problems.push('preload.js 里用了 `invoke(\'app:capProfile\'`（' + invokes + ' 次）—— 这条通知是**单向下行**，不该等回执');
  if (!/capProfile\s*:/.test(pre)) problems.push('preload.js 的 desktop.app 上找不到 `capProfile:` 这个键（渲染层拿不到入口）');

  // ② 接收端
  const main = sources['main.js'] || '';
  const mainCode = codeLines(main).join('\n');
  const onCalls = (mainCode.match(/ipcMain\.on\(\s*'app:capProfile'/g) || []).length;
  readings.mainOn = onCalls;
  if (onCalls !== 1) problems.push('main.js 里 `ipcMain.on(\'app:capProfile\'` 出现 ' + onCalls + ' 次（必须恰好 1 次）—— 订阅者只能有一个');
  const idx = mainCode.indexOf("ipcMain.on('app:capProfile'");
  if (idx >= 0) {
    const tail = mainCode.slice(idx, idx + 1200);
    readings.handlerCallsSync = tail.indexOf('syncCapMenu()') >= 0;
    if (tail.indexOf('syncCapMenu()') < 0) problems.push('`app:capProfile` 的回调里没有调 `syncCapMenu()` —— 菜单不会刷新（接了但没生效）');
  }

  // ③ 两条菜单项必须走运行时闸
  [['map-menu-expand-all', 'menu:expand-all'], ['map-menu-collapse-all', 'menu:collapse-all']]
    .forEach(([id, channel]) => {
      const want = "sendIfCap('" + id + "', '" + channel + "')";
      const n = (mainCode.split(want).length - 1);
      readings['click_' + id] = n;
      if (n !== 1) problems.push('main.js 里 `' + want + '` 出现 ' + n + ' 次（必须恰好 1 次）—— 菜单项没走能力闸，快捷键/点击能绕过剖面');
      const raw = "click: () => send('" + channel + "')";
      if (mainCode.indexOf(raw) >= 0) problems.push('main.js 里还留着裸 click（`' + raw + '`）—— 那就是绕过能力闸的第二条路');
    });

  // ④ 剖面名字面量 === 0（按名字扫；例外只有 Node 的 require('path')，见 countProfileLiterals）
  Object.keys(FILES).forEach((rel) => {
    const src = sources[rel];
    if (typeof src !== 'string') { problems.push(rel + ' 读不到（扫描面必须完整，缺一份就判不了）'); return; }
    /* 只扫**代码行**：注释里举 `path` 这种例子是文档，不是"按名字分支"的路。
     * （`index.html` 是骨架、没有注释行的问题；其余四份用同一条口径，别按文件分两套规矩。） */
    const c = countProfileLiterals(codeLines(src).join('\n'), PROFILES);
    const total = PROFILES.reduce((n, k) => n + c[k], 0);
    readings['literals_' + rel] = total;
    if (total > 0) {
      const hit = PROFILES.filter((k) => c[k] > 0).map((k) => k + '×' + c[k]).join(' ');
      problems.push(rel + ' 里出现了 ' + total + ' 处剖面名字面量（' + hit + '）—— 剖面轴要**按能力判**，一出现按名字分支的路就打开了');
    }
  });

  // ④b 渲染层的发送点：恰好一处，且在剖面落地之后那一行；同一函数里不许有定时器（= 事件驱动，不是轮询）
  const core = sources['renderer/app-core.js'] || '';
  const coreCode = codeLines(core).join('\n');
  const sends2 = (coreCode.match(/app\.capProfile\s*\(/g) || []).length;
  readings.rendererSendSites = sends2;
  if (sends2 !== 1) problems.push('renderer/app-core.js 里 `app.capProfile(` 出现 ' + sends2 + ' 次（必须恰好 1 处：多个发送点 = 多条刷新路，必然漏一处）');
  const body = fnBody(core, 'applyCapSurface');
  if (!body) problems.push('renderer/app-core.js 里找不到 `applyCapSurface` 的函数体 ⇒ 判不了"发送点落在剖面具现之后"');
  else {
    readings.sendInsideApply = body.indexOf('app.capProfile(') >= 0;
    if (body.indexOf('app.capProfile(') < 0) problems.push('发送点不在 `applyCapSurface` 里 —— 剖面有好几个入口（下拉框/切回全开/启动缺省），挂在入口上必然漏一处');
    const timers = (body.match(/setInterval|setTimeout/g) || []).length;
    readings.timersInApply = timers;
    if (timers > 0) problems.push('`applyCapSurface` 里出现了 ' + timers + ' 处定时器 —— 刷新必须是**事件驱动**：定时器会在"切完剖面"与"菜单变灰"之间留一拍，那一拍正好能从菜单绕过限制');
  }

  return { ok: problems.length === 0, problems, readings };
}

describe('剖面 ⇒ 原生菜单：IPC 两端 + 能力闸 + 剖面名零字面量', () => {
  it('真源码：发送端与接收端都在、菜单项走能力闸、剖面名字面量 === 0、刷新是事件驱动', () => {
    const r = judge(realSources());
    expect(r.problems, '判据报出的问题：\n' + r.problems.join('\n')).toEqual([]);
    expect(r.ok).toBe(true);
    // 读数也要对（防"问题列表为空"是因为一条都没扫到）
    expect(r.readings.preloadSend).toBe(1);
    expect(r.readings.mainOn).toBe(1);
    expect(r.readings.rendererSendSites).toBe(1);
    expect(r.readings.handlerCallsSync).toBe(true);
    expect(r.readings.sendInsideApply).toBe(true);
    expect(r.readings.timersInApply).toBe(0);
  });

  it('判别力（注入）：喂一份**每一条都违规**的假源码 ⇒ 同一个 judge 必须逐条报出来', () => {
    const base = realSources();
    const bad = {
      ...base,
      'preload.js': base['preload.js'].replace("ipcRenderer.send('app:capProfile', profile)",
        "ipcRenderer.invoke('app:capProfile', profile)"),   // ① 断头：没有发送端
      'main.js': base['main.js']
        .replace("ipcMain.on('app:capProfile'", "ipcMain.on('app:capProfiles'")     // ② 订阅者消失
        .replace("click: sendIfCap('map-menu-expand-all', 'menu:expand-all')",
          "click: () => send('menu:expand-all')"),                                   // ③ 绕过能力闸
      'renderer/app.js': base['renderer/app.js'] + "\nvar probe = '" + PROFILES[0] + "';\n"  // ④ 剖面名字面量
    };
    const r = judge(bad);
    expect(r.ok).toBe(false);
    const all = r.problems.join(' | ');
    expect(all, '没有报出 preload 那一头断了').toMatch(/preload\.js/);
    expect(all, '没有报出 main.js 的订阅者没了').toMatch(/ipcMain\.on/);
    expect(all, '没有报出菜单项绕过了能力闸').toMatch(/能力闸|sendIfCap|裸 click/);
    expect(all, '没有报出剖面名字面量').toMatch(/字面量/);
  });
});
