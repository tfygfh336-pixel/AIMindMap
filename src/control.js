/* ============================================================
 * src/control.js —— 界面控制通道（文件式，**不依赖网络/管道**）
 * ------------------------------------------------------------
 * 用途：让**外部 AI 与内置 DSH 侧栏**能命令正在运行的界面做一件事，典型是
 * "关掉左边思维导图页、只留侧栏"（用户要的那个接口）。人类不需要调用它 —— 人类按 ✕ 就行。
 *
 * 为什么是文件而不是 socket / 命名管道：
 *   · 本机受限环境**禁止程序开命名管道**（本工程实测过 spawn/管道类失败）；
 *   · 网络要走策略代理，localhost 也未必通 ⇒ 两者都会把"能不能用"变成环境问题。
 *   文件 + 轮询是唯一在所有环境里都成立的通道，代价是几百毫秒延迟（这类操作完全够）。
 *
 * ---------------- 协议（v2：多槽 + 序号 + 取走即认领） ----------------
 * 目录（都在应用 userData 下）：
 *   control/pending/<token>.json     调用方写：{ token, cmd, … , at, by }
 *   control/done/<token>.json        界面写回：{ token, cmd, ok, …, at }
 *   control/consuming/<token>.json   界面**取走**时的认领位（原子 rename；正常情况下很快消失）
 * 调用方只认 **自己那个 token** 的回执（`waitForResult(dir, token, ms)`）——
 * 于是"两个 CLI 进程同时下命令"不再互相覆盖：它们各自写各自的槽 ✓。
 *
 * 为什么要改（实测取证 2026-10-10，本机 batch-1 报告 ⑦-2）：
 *   · **单槽**：两个 CLI 同时 `dsh-prefill` 时都写同一个 `mm-control.json` —— 后写的把先写的覆盖掉，
 *     先写的那一方**永远等不到回执**（而它其实什么都没做错）。这不是理论风险：本工程的常态就是
 *     "多个 AI 会话同时在用同一个界面"。
 *   · **重复派发**：旧实现的"取命令"是 `readCommand()`，而**清掉**命令要等异步工作做完 ——
 *     这 400ms 轮询在这中间会**再读一遍同一条命令**并再派发一次（`dsh-prefill` 被派发两次 ⇒
 *     `show()` / `executeJavaScript` 各跑两遍）。幂等不等于无害：多跑的那一遍会与第一遍抢同一个
 *     webContents。
 *   ⇒ 新协议把这两件事都做成**机械可判定**的：token 隔离写入、`rename` 原子认领（认领后原路径
 *     就不存在了 ⇒ 同一条命令**至多**一个消费者）。
 *
 * 归档（为什么是三个状态而不是一个"已消费"标记文件）：标记文件要"读标记 + 写标记"，本身又是
 *   一次竞态；而 `rename` 是文件系统层面的原子操作 —— **状态即路径**，没有中间态可被读到 ✓。
 *
 * 口径不变：**没有回执就等于没生效** —— CLI 会因此报错退出，而不是假装成功
 *   （本工程最重的损害类别是静默）。
 *
 * **慢命令的调用方：先用 `dsh-status` 探活，再下慢命令**（`cli/commands/ui.js` 的 `dsh-prefill` 就这么做）。
 * 为什么：`dsh-prefill` 内部可能要把**侧栏服务起起来**（冷启动实测几秒，最坏 ≈12.4s），
 *   于是"界面没在跑"与"界面在跑但慢"在**只看这一个回执**时完全一样（都是没有回执）⇒
 *   调用方只能在"白等满窗口才敢判失败"与"提前放弃、把还在干活说成没响应"之间二选一
 *   （实测修前：失败路径 12.56s，而同批另三条命令 ~3.0s；且 12s 窗口 < app 侧最坏 12.4s ⇒
 *   界面还在干活就会被判"没响应"，那是**假原因**）。
 *   `dsh-status` 是**只读**探针、当场可答（无慢路径）⇒ 有回执 = 界面活着，可以放心等；
 *   没回执 = 真没在跑，立刻报错。这样不必改协议、也不必要求界面升级（旧实例一样适用）。
 *
 * 本模块是**纯文件读写**、不 require electron ⇒ 可被单测与 CLI 同时使用（同一份协议）。
 * ============================================================ */
'use strict';

/* ---------- UMD 头（形态照 `docs/ARCHITECTURE.md` §2.3；对照模块 `src/palette-rank.js`）----------
 * 修复前（2026-10-20 实测）：`fs` / `path` / `crypto` 三条 `require` 直接写在模块顶层 ⇒ 浏览器端
 * 加载抛 `ReferenceError: require is not defined`（整份模块连加载都不成）。
 * 本模块是**控制通道的文件协议**（要读写盘、要 `process.pid`）⇒ 浏览器端本来就不该能用；
 * 合规做法是**显式守卫**：函数都在，调到就抛一句明确的话（见下面的 nodeTrap / nodeGlobal）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('fs'), require('path'), require('crypto'), process);
  } else {
    root.MMControl = factory(nodeTrap('fs'), nodeTrap('path'), nodeTrap('crypto'), nodeGlobal('process'));
  }
  /* 浏览器端的 Node 替身。为什么是**两个**、而不是一个"取属性即抛"的：
   *   · `nodeTrap(name)`：取属性得一个**调用即抛**的函数。有的模块在加载时就解构拿函数
   *     （`const { spawnSync } = require('child_process')`）—— "取属性即抛"会让那种加载直接崩。
   *   · `nodeGlobal(name)`：**取属性即抛**。`process.pid` / `process.env` 不是函数，
   *     若也返回"调用才抛"的假函数，它会被拼进字符串**静默算出垃圾**（那种失败比崩还坏）。
   */
  function nodeTrap(name) {
    const no = (prop) => function () {
      throw new Error('src/control.js 的 ' + name + '.' + prop + ' 需要 Node 环境（浏览器端没有 ' + name
        + '；控制通道读写盘请走 CLI / IPC）');
    };
    return new Proxy({}, { get: (_t, prop) => (typeof prop === 'symbol' ? undefined : no(String(prop))) });
  }
  function nodeGlobal(name) {
    return new Proxy({}, {
      get: (_t, prop) => {
        if (typeof prop === 'symbol') return undefined;
        throw new Error('src/control.js 需要 Node 环境（浏览器端没有 ' + name + '.' + String(prop) + '；请走 CLI / IPC）');
      }
    });
  }
})(typeof self !== 'undefined' ? self : this, function (fs, path, crypto, process) {

const DIR = 'control';
const PENDING = 'pending';
const DONE = 'done';
const CONSUMING = 'consuming';
/** 认领之后多久没写完回执 = 孤儿（进程被杀/崩溃）⇒ 清掉，**不**放回 pending。
 *  为什么不放回：命令体可能已经执行到一半（"关一半"），重放比丢失更危险；而"没有回执"这条口径
 *  本来就会让调用方判失败 ✓（宁可让调用方重下一次，也不要自己猜"它到底做没做"）。 */
const ORPHAN_MS = 120000;
/** pending 目录的硬上限：调用方崩在写之前会留下垃圾。超了只**如实告警**并清掉最老的，
 *  免得一个坏掉的脚本把目录撑成几万个文件（诊断信息仍然出现在 stderr，不静默）。 */
const MAX_PENDING = 200;

/** 通道目录（baseDir 用应用 userData 目录；CLI 与界面必须推导出同一个） */
function paths(baseDir) {
  const root = path.join(baseDir, DIR);
  return {
    root: root,
    pending: path.join(root, PENDING),
    done: path.join(root, DONE),
    consuming: path.join(root, CONSUMING)
  };
}

/** 原子写：先写临时文件再改名（半截文件会被读成"没有命令"，但绝不能读成半条命令） */
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* ignore */ }
    throw err;
  }
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch (err) { return null; }   // 不存在 / 半截 / 坏 JSON 一律当作"没有"
}

function ensureDirs(p) {
  [p.root, p.pending, p.done, p.consuming].forEach((d) => fs.mkdirSync(d, { recursive: true }));
}

/**
 * 新 token（**调用方生成**）。为什么由调用方生成而不是界面发号：
 *   发号要"先问界面再下命令"多一个往返（界面没在跑时还会白等），而 token 只需要**唯一**，
 *   pid + 计数 + 随机数已经足够（进程内自增防同毫秒重复）。
 */
let seq = 0;
function newToken(prefix) {
  seq = (seq + 1) % 100000;
  return (prefix ? String(prefix) + '-' : '')
    + process.pid.toString(36) + '-' + Date.now().toString(36) + '-' + seq.toString(36)
    + '-' + crypto.randomBytes(3).toString('hex');
}

function tokenFile(p, token) { return path.join(p.pending, token + '.json'); }
function doneFile(p, token) { return path.join(p.done, token + '.json'); }
function consumingFile(p, token) { return path.join(p.consuming, token + '.json'); }

/** 一条命令写进自己的槽（**绝不覆盖别人的**：文件名就是 token） */
function writeCommand(baseDir, cmd) {
  const p = paths(baseDir);
  ensureDirs(p);
  const token = (cmd && cmd.token) || newToken('cmd');
  const body = Object.assign({}, cmd, { token: token });
  writeJsonAtomic(tokenFile(p, token), body);
  return body;
}

/** 调用方读**自己那条命令**的当前形态（诊断/断言用；不吃回执 ⇒ 不会与界面的认领抢） */
const readPending = (baseDir, token) => {
  const p = paths(baseDir);
  return readJson(tokenFile(p, token)) || readJson(consumingFile(p, token));
};

/**
 * 界面侧：列出当前待处理的命令（按文件名排序 = token 里的时间序，先来先做）。
 *
 * ⚠️ 排序**必须在过滤之前**做（`filter` 会改变下标，先 map/filter 再 sort 拿到的是
 *   「活下来的那几条之间」的顺序，而"先来先做"要的是**全部**文件名序）。
 *   第一版写成了 `…sort().map(…).filter(Boolean)` ⇒ 只要有坏文件被丢掉，相对顺序就可能翻 ✗
 *   （坏文件恰好排在前面时，两条好命令的先后会颠倒）。
 *
 * @param {(dropped:string[])=>void} [onDropped] 收到"当作没有命令"的文件名（半截/坏 JSON/没有 token）。
 *   为什么要这个口子：丢弃**必须可见** —— 静默丢一条命令的表现是"调用方等到超时、而日志什么都没有"，
 *   排查时无从下手（本工程最忌的"没做，却看不出没做"）。
 * @returns {Array<object>} 可执行的命令对象（含 token）
 */
function listPending(baseDir, onDropped) {
  const p = paths(baseDir);
  const dropped = [];
  let out = [];
  try {
    const names = fs.readdirSync(p.pending).filter((f) => f.slice(-5) === '.json').sort();
    out = names.map((f) => {
      const cmd = readJson(path.join(p.pending, f));
      // 坏 JSON / 半截文件当"没有命令"（不能打断轮询）；缺 token 的同样不能派发 ——
      // 回执是按 token 认的，没有 token 就没有"回执该写给谁"（派发它 = 调用方永远等不到）
      if (!cmd || !cmd.token) { dropped.push(f); return null; }
      return cmd;
    }).filter(Boolean);
  } catch (err) { out = []; }
  if (dropped.length && typeof onDropped === 'function') onDropped(dropped);
  return out;
}

/**
 * 界面侧：**原子认领**一条命令。
 * 返回 null = 这条已经被别人（或同一进程的上一拍）认领走了 ⇒ 调用方**不许**再执行它。
 * 这是"同一条命令只被派发一次"的全部机制：认领靠 `rename`，而 rename 只有一个赢家 ✓。
 */
function claim(baseDir, token) {
  const p = paths(baseDir);
  ensureDirs(p);
  try {
    fs.renameSync(tokenFile(p, token), consumingFile(p, token));
  } catch (err) {
    return null;   // 已被认领 / 已消失 / 目录没了 —— 三种都一样：**不要重试**
  }
  return readJson(consumingFile(p, token));
}

/** 界面侧：写回执（按 token）；写完顺手把认领位清掉（正常情况下它只活一个来回） */
function writeResult(baseDir, token, result) {
  const p = paths(baseDir);
  ensureDirs(p);
  const body = Object.assign({}, result, { token: token });
  writeJsonAtomic(doneFile(p, token), body);
  try { fs.rmSync(consumingFile(p, token), { force: true }); } catch (err) { /* ignore */ }
  return body;
}

/** 调用方：读**自己那条命令**的回执（读不到 = null ⇒ 判"没生效"） */
const readResult = (baseDir, token) => readJson(doneFile(paths(baseDir), token));

/** 调用方/界面都能用：丢掉某个 token 的痕迹（调用方读走回执后清理用） */
function clear(baseDir, token) {
  const p = paths(baseDir);
  try { fs.rmSync(doneFile(p, token), { force: true }); } catch (err) { /* ignore */ }
  try { fs.rmSync(tokenFile(p, token), { force: true }); } catch (err) { /* ignore */ }
  try { fs.rmSync(consumingFile(p, token), { force: true }); } catch (err) { /* ignore */ }
}

/** 界面侧：清理孤儿（认领后一直没回执）与超量的 pending，返回**做了什么**（调用方决定要不要喊一声） */
function sweep(baseDir, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const orphanMs = Number.isFinite(o.orphanMs) ? o.orphanMs : ORPHAN_MS;
  const p = paths(baseDir);
  const out = { orphans: [], dropped: [], donePruned: 0 };
  let items = [];
  try { items = fs.readdirSync(p.consuming); } catch (err) { items = []; }
  items.forEach((f) => {
    const abs = path.join(p.consuming, f);
    try {
      if (now - fs.statSync(abs).mtimeMs > orphanMs) { fs.rmSync(abs, { force: true }); out.orphans.push(f); }
    } catch (err) { /* 单个失败不影响其余 */ }
  });
  let pending = [];
  try { pending = fs.readdirSync(p.pending).sort(); } catch (err) { pending = []; }
  if (pending.length > MAX_PENDING) {
    const drop = pending.slice(0, pending.length - MAX_PENDING);
    drop.forEach((f) => {
      try { fs.rmSync(path.join(p.pending, f), { force: true }); out.dropped.push(f); }
      catch (err) { /* ignore */ }
    });
  }
  // 回执目录：调用方读走后一般自己删；这里兜底清掉**明显过期**的（界面没在跑时调用方也会超时放弃）
  let doneItems = [];
  try { doneItems = fs.readdirSync(p.done); } catch (err) { doneItems = []; }
  doneItems.forEach((f) => {
    const abs = path.join(p.done, f);
    try {
      if (now - fs.statSync(abs).mtimeMs > orphanMs) { fs.rmSync(abs, { force: true }); out.donePruned++; }
    } catch (err) { /* ignore */ }
  });
  return out;
}

/** 调用方：等**自己那条命令**的回执。
 *  ⚠️ 只认对应 token，且 `at` 必须落在本次等待窗口内 —— 旧实现是"只认 cmd 名 + 新鲜度"，
 *  而**同名命令**在同一窗口里并发时两者会互相吃到对方的回执（多槽之后这一条必须一起改 ✗）。
 *  真实事故记录：应用**没在运行**时，目录里留着的 4.5 小时前的旧回执被当成实时结果。
 *  注入点：`sleep` 可注入（单测零等待覆盖分支），默认忙等 100ms。 */
function waitForResult(baseDir, token, timeoutMs, sleep) {
  const wait = typeof sleep === 'function' ? sleep : (() => { const t0 = Date.now(); while (Date.now() - t0 < 100) { /* spin */ } });
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = readResult(baseDir, token);
    const at = r && r.at ? Date.parse(r.at) : NaN;
    const fresh = Number.isFinite(at) && at >= Date.now() - timeoutMs - 3000;
    if (r && r.token === token && fresh) return r;
    wait();
  }
  return null;
}

return {
  CMD_FILE: DIR, RESULT_FILE: DIR,      // 兼容旧字段名（都指向同一个通道目录；不再有"单文件"语义）
  DIR, ORPHAN_MS, MAX_PENDING,
  paths, newToken, writeCommand, readPending, listPending, claim, writeResult, readResult, clear, sweep,
  waitForResult
};
});
