/* ============================================================
 * scripts/smoke/husk-sweep.js —— 冒烟沙箱「上一轮的死壳」清扫（纯逻辑 + 一小段 I/O，**可注入**）
 * ------------------------------------------------------------
 * 为什么单独成一个模块：这段逻辑原先内联在 `main.js` 的 `sweepSmokeHusks()` 里，
 * 而 `main.js` **要 Electron 才能加载** ⇒ 判定逻辑**从来没有单测**（与 `src/control-poll.js`
 * 当年被抽出来是同一个理由）。抽出来之后：`require` 零副作用、时钟/文件系统/pid 活性全部
 * 从参数进 ⇒ 2026-10-19 W5 批的两处注入（退回非递归 / 预置非空壳）才能**真红**。
 *
 * ## 病（本批现算读数，不是手抄）
 * `%TEMP%` 里 `ai-mind-map-smoke-*` **35 个**：空壳 **1**、非空 **34**，共 **1,113 文件 / 226.6 MB**。
 * 旧实现只调 **非递归** `rmdirSync` ⇒ 非空的那 34 个**物理上永远删不掉**（"自愈"在跑，但删不动）。
 *
 * ## 为什么当初是**非递归**（旧头注的原话，理由要逐条判，不许一句"改成递归"了事）
 *   ②「只调 `rmdirSync`（非递归）⇒ 有内容的目录物理上删不掉，**不可能误删"正在跑的那一轮"的数据**」
 *   ③「跳过 mtime 在最近 60 秒内的 —— 活着的沙箱只在"建好目录、还没拷项目"的微秒窗口里是空的，
 *      60 秒的余量把"误删别人正在用的沙箱"这条风险压到实际为零」
 * ⇒ **② 是 ③ 能成立的前提**：60 秒这条线之所以安全，**靠的是非递归**（超过 60 秒的活沙箱已经是
 *   非空的，而 rmdirSync 删不动它）。一旦改成递归，③ 立刻**失效**：一轮 full 冒烟实测 **1004.6 s**
 *   （`scripts/verify.js` 的 G5 预算 1300 s）⇒ "开跑第 61 秒的活沙箱"是常态，60 秒线会**删掉正在跑的那一轮**。
 * ⇒ 所以：**目标（不许误删在跑的那一轮）仍然成立**，被替换的只是它当年的**实现手段**。
 *   本模块换成两条**显式**的活性判据（都不靠"删得动删不动"这种副作用）：
 *     ① **活实例登记**（照 `scripts/cli-integration.js` 已建的范式）：开跑就建一个**空目录锁**
 *        `%TEMP%/mm-live-runs/smoke-<pid>-<开工时刻36进制>-<随机>`，pid 与开工时刻**全在名字里**
 *        ⇒ `process.kill(pid, 0)` 判活；**僵尸登记当死清掉**（不清的话"有人占着"会永久为真 ⇒ 自愈永久失效）。
 *        ⚠️ 前缀用 `smoke-` 而**不是** `run-`：`cli-integration.js` 的 `liveSiblingRuns()` 只认 `run-`
 *        开头，两边互不认作"兄弟" —— 否则本模块的登记会让 G4 退回保守口径，G2 紧跟其后 ⇒ **假红**。
 *     ② **年龄线**（有别的实例在跑 / 活性判不了时）：**3600 s**，理由见 `SAFE_AGE_MS` 的注释。
 *
 * ## 判据分成几档（B4c：数数型判据先数清它可能输出几种判定）
 * 每一轮返回 `mode`：`idle`（盘上没有任何活实例）/ `busy`（有别的实例在跑）/ `unknown`（登记读不出来
 * 或自己的登记没建上 ⇒ **判不了**），并**逐壳**给出 `swept` / `held` / `failed` 三档之一：
 *   · `swept`  = 真删掉了（递归，连字节数一起报）
 *   · `held`   = 故意不动（点名`why`：`self-fresh` / `busy` / `unknown`）—— **不是失败**
 *   · `failed` = 该删但**删不掉**（带 `code`：`EPERM` / `EBUSY` / `STILL_EXISTS` …）—— **删不掉才报**
 * 这三档压成一个 0 就等于把"没删"与"删失败"合并（`temp-run-root.js` 2026-10-18 栽过同一形状）。
 * ============================================================ */
'use strict';

const nodeFs = require('fs');
const nodeOs = require('os');
const nodePath = require('path');

/** 沙箱目录前缀 —— 与 `main.js` 里 `fs.mkdtempSync(path.join(os.tmpdir(), 'ai-mind-map-smoke-'))`
 *  的那个前缀**逐字相同**（`tests/smoke-husk-sweep.test.js` 有一条结构断言钉住它，见那条测试的理由）。 */
const HUSK_PREFIX = 'ai-mind-map-smoke-';

/** 活实例登记目录（与 `scripts/cli-integration.js` 合用同一个目录、**不同前缀**，理由见文件头）。 */
const LIVE_DIR_NAME = 'mm-live-runs';
/** 本模块的登记前缀。**必须与本文件头说的一致**：`cli-integration.js` 只认 `run-`。 */
const CLAIM_PREFIX = 'smoke-';

/**
 * 年龄线（有别的实例在跑 / 活性判不了时用）—— **3600 s**。
 * 为什么是"远大于一轮冒烟"，读数（不是估）：一轮 **full** 冒烟实测 **1004.6 s**
 * （`CHANGELOG` 的 G5 读数）、`scripts/verify.js` 给它的止涨预算 **1300 s** ⇒
 *   3600 s ÷ 1004.6 s = **3.58 倍**；3600 s ÷ 1300 s = **2.77 倍**。
 * 旧线是 60 s（÷1004.6 = 0.06 倍 ⇒ 它在递归删除下**必然**误删在跑的那一轮，见文件头）。
 * ⚠️ 这条线只解决"**判不了**时怎么办"；能判活的时候由登记说话，不必等一小时（见 `SELF_FRESH_MS`）。
 */
const SAFE_AGE_MS = 60 * 60 * 1000;

/**
 * "无任何活实例"档的**自身新鲜期** —— 60 s（沿用旧 ③ 的取值，但**语义变了**，别照抄结论）：
 * · 旧 ③ 用它保护"**别人**正在用的沙箱"（靠非递归兜底）；
 * · 这里它只保护"**建好目录、还没拷项目**"那个微秒窗口 —— 这个窗口属于**本进程之外**唯一还可能
 *   存在、却**没有登记**的沙箱（老版本二进制 / 登记失败）。窗口是微秒级，60 s 是它的 6 个数量级以上。
 * · `idle` 档下"活沙箱被误删"**按构造不可能**：本代码每一轮开跑都先建登记（`makeClaim()`），
 *   有登记 ⇒ `liveClaims()` 看得见 ⇒ 进的是 `busy` 档。**残余边界**（如实记）：**改动前**编译的
 *   旧版二进制在跑 `--smoke` 时不会登记 ⇒ 对那一份，本模块只能靠 60 s。方向保守、爆炸半径是
 *   "那一轮冒烟报错"，**永远不碰用户真实项目**（沙箱本身是副本）。
 */
const SELF_FRESH_MS = 60 * 1000;

/**
 * 登记超过它就**当僵尸**（pid 复用 / 挂死）。取值 = `SAFE_AGE_MS`：一轮真冒烟 ≤ 1300 s 预算 ⇒
 * 一小时都还活着的登记不可能是"正在跑的那一轮"。与 `cli-integration.js` 的 `MAX_RUN_MS` 同形（那里 30 分钟）。
 */
const MAX_CLAIM_AGE_MS = 60 * 60 * 1000;

/** 一次性把注入点收齐（全部可选）：测试只注入它关心的那几个，其余回落到真实实现。 */
function io0(io) {
  const o = io || {};
  return {
    fs: o.fs || nodeFs,
    path: o.path || nodePath,
    tmpDir: o.tmpDir || (o.os || nodeOs).tmpdir(),
    now: typeof o.now === 'function' ? o.now : Date.now,
    pid: o.pid === undefined ? process.pid : o.pid,
    isAlive: typeof o.isAlive === 'function' ? o.isAlive : defaultIsAlive,
    liveDir: o.liveDir || null,
    selfName: o.selfName || '',
    // ⚠️ `selfName` 与 `selfClaimName` 是**两个不同的名字**（2026-10-19 全链 G5 的读数抓到的漏接）：
    //   · `selfName`      = **自己的沙箱目录名**（`ai-mind-map-smoke-XXXXXX`）—— 清扫时必须跳过，
    //     否则会把自己正在用的沙箱当死壳（旧实现用 `path.basename(SMOKE_PROJECTS_DIR)` 挡的就是这个）；
    //   · `selfClaimName` = **自己的活实例登记名**（`smoke-<pid>-…`）—— 判活时不算"别的实例"。
    //   两者混用会出现"每轮都把自己那份算成 self-fresh 暂不动"的噪声读数（真 self-fresh 会被盖掉）。
    selfClaimName: o.selfClaimName === undefined ? (o.selfName || '') : o.selfClaimName,
    claimOk: o.claimOk
  };
}

/** pid 活性判据（**唯一一处**口径）。`process.kill(pid, 0)`：不真发信号，只问"在不在"。
 *  Windows 上它是 `TerminateProcess` 之外唯一可用的探活方式；`EPERM` = 进程在、只是不许发信号。 */
function defaultIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return !!(err && err.code === 'EPERM'); }
}

function liveDirOf(io) {
  return io.liveDir || io.path.join(io.tmpDir, LIVE_DIR_NAME);
}

/** 登记名：`smoke-<pid>-<开工时刻36进制>-<随机>`。内容全在名字里 ⇒ **不必写文件**（目录创建是原子的，
 *  没有"半个登记"这种失败形态；也不新增写盘调用点 —— `WRITE_OUTLET_SITE_CAP` 只认 `writeFileSync` 那族）。 */
function claimNameFor(pid, startedAtMs, rand) {
  return CLAIM_PREFIX + pid + '-' + Number(startedAtMs).toString(36) + '-'
    + String(rand === undefined ? Math.random().toString(36).slice(2, 8) : rand);
}

/** 拆登记名。**拆不出 pid / 开工时刻的条目一律当死**（僵尸留在那里会把每一轮都变成"有别人在跑"
 *  ⇒ 自愈永久失效，比残留本身更坏）。 */
function parseClaimName(name) {
  if (typeof name !== 'string' || name.indexOf(CLAIM_PREFIX) !== 0) return null;
  const m = name.slice(CLAIM_PREFIX.length).split('-');
  const pid = Number(m[0]);
  const startedAt = parseInt(m[1], 36);
  if (!isFinite(pid) || pid <= 0 || !isFinite(startedAt)) return null;
  return { pid: pid, startedAt: startedAt };
}

/**
 * 建**本进程**的登记（空目录锁）。返回句柄，`ok:false` 时**不抛** —— 登记不上就退化成保守口径，
 * 由 `sweepHusks()` 读 `claimOk` 决定（见那里：`unknown` 档 ⇒ 只按 3600 s 走）。
 * @param {{fs?:object, path?:object, tmpDir?:string, pid?:number, now?:function, rand?:string}} [io]
 */
function makeClaim(io) {
  const i = io0(io);
  const dir = liveDirOf(i);
  const name = claimNameFor(i.pid, i.now(), io && io.rand);
  const full = i.path.join(dir, name);
  let ok = true;
  let error = '';
  try {
    i.fs.mkdirSync(dir, { recursive: true });
    i.fs.mkdirSync(full);                    // 非 recursive：已存在就抛（撞名 = 有人真的在用这个名字）
  } catch (err) {
    ok = false;
    error = (err && err.code) || String((err && err.message) || err);
  }
  return {
    ok: ok, error: error, name: name, dir: full,
    /** 收尾释放。**不许抛**（退出路径）。删不掉也无所谓：下一次开跑按 pid 判死会当僵尸清掉。 */
    release() { try { i.fs.rmSync(full, { recursive: true, force: true }); } catch (err) { /* 退出路径不许再抛 */ } }
  };
}

/**
 * 还活着的**别的**实例。顺带把僵尸登记（pid 已死 / 名字拆不出 pid / 超过 `MAX_CLAIM_AGE_MS`）**清掉**。
 * @returns {{ok:boolean, runs:Array<{pid:number,startedAt:number,name:string}>, reaped:number,
 *            liveDir:string, error:string}}
 *  `ok:false` = 登记目录读不出来（判不了 ⇒ 调用方**必须**保守）。
 */
function liveClaims(io) {
  const i = io0(io);
  const dir = liveDirOf(i);
  const now = i.now();
  const out = { ok: true, runs: [], reaped: 0, liveDir: dir, error: '' };
  let names = [];
  try { names = i.fs.readdirSync(dir); }
  catch (err) {
    const code = (err && err.code) || '';
    // ENOENT = 从没有实例登记过（这不是"判不了"，是"确实没人"）
    if (code === 'ENOENT') return out;
    out.ok = false;
    out.error = code || String((err && err.message) || err);
    return out;
  }
  for (const f of names) {
    if (f === i.selfClaimName) continue;            // 自己那条不算"别人"（登记名 ≠ 沙箱名，见 io0）
    const parsed = parseClaimName(f);
    const p = i.path.join(dir, f);
    let alive = false;
    if (parsed && parsed.pid !== i.pid) {
      if (i.isAlive(parsed.pid)) alive = true;
      if (alive && now - parsed.startedAt > MAX_CLAIM_AGE_MS) alive = false;   // 超龄 ⇒ pid 复用 / 挂死
    }
    if (!alive) {
      try { i.fs.rmSync(p, { recursive: true, force: true }); out.reaped += 1; } catch (err) { /* 清僵尸失败不判红 */ }
      continue;
    }
    out.runs.push({ pid: parsed.pid, startedAt: parsed.startedAt, name: f });
  }
  return out;
}

/** 目录树字节数（只用于**读数**：清掉多少要有数字。读不到就返回 0，不许因此判红）。 */
function treeBytes(dir, fs, path) {
  let total = 0;
  let stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch (err) { continue; }
    for (const e of ents) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      try { total += fs.statSync(p).size; } catch (err) { /* 并发消失 ⇒ 当 0 */ }
    }
  }
  return total;
}

/**
 * 清扫 `%TEMP%` 下**上一轮的死壳**。
 * @param {{fs?:object,path?:object,tmpDir?:string,now?:function,pid?:number,isAlive?:function,
 *          liveDir?:string,selfName?:string,claimOk?:boolean}} [io]
 * @returns {{ok:boolean, mode:string, thresholdMs:number, swept:Array, sweptBytes:number, held:Array,
 *           failed:Array, live:number, reaped:number, error:string}}
 */
function sweepHusks(io) {
  const i = io0(io);
  const now = i.now();
  const out = {
    ok: true, mode: 'idle', thresholdMs: SELF_FRESH_MS, swept: [], sweptBytes: 0,
    held: [], failed: [], live: 0, reaped: 0, error: ''
  };
  const claims = liveClaims(i);
  out.live = claims.runs.length;
  out.reaped = claims.reaped;
  if (!claims.ok) { out.mode = 'unknown'; out.error = claims.error; }
  else if (claims.runs.length > 0) out.mode = 'busy';
  // 自己的登记没建上 ⇒ 我们**可能也看不见别人**的登记 ⇒ 不许进 idle 档（判不了就保守）
  else if (i.claimOk === false) { out.mode = 'unknown'; out.error = 'claim-failed'; }
  out.thresholdMs = out.mode === 'idle' ? SELF_FRESH_MS : SAFE_AGE_MS;

  let entries = [];
  try { entries = i.fs.readdirSync(i.tmpDir, { withFileTypes: true }); }
  catch (err) {
    out.ok = false;
    out.error = String((err && err.message) || err);
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === i.selfName) continue;
    if (e.name.indexOf(HUSK_PREFIX) !== 0) continue;          // 只认**自己**的前缀，别人的目录一个都不碰
    const p = i.path.join(i.tmpDir, e.name);
    let st = null;
    try { st = i.fs.statSync(p); } catch (err) { continue; }   // 刚被别人删掉 ⇒ 不是失败
    const ageMs = now - st.mtimeMs;
    if (ageMs < out.thresholdMs) {
      out.held.push({ name: e.name, ageMs: ageMs, why: out.mode === 'idle' ? 'self-fresh' : out.mode });
      continue;
    }
    // ⭐ 递归删除（旧实现这里是**非递归** `rmdirSync` ⇒ 非空壳物理上删不掉，就是本批的缺口）
    const bytes = treeBytes(p, i.fs, i.path);
    let code = '';
    try { i.fs.rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }); }
    catch (err) { code = (err && err.code) || String((err && err.message) || err); }
    if (!code) {
      let still = false;
      try { still = i.fs.existsSync(p); } catch (err) { still = true; }
      if (still) code = 'STILL_EXISTS';                        // 删了但还在 ⇒ 一样算"删不掉"
    }
    if (code) out.failed.push({ name: e.name, code: code, bytes: bytes });
    else { out.swept.push({ name: e.name, bytes: bytes }); out.sweptBytes += bytes; }
  }
  // `ok:false` 只有两种含义：**该删的没删掉**（`failed` 非空）或**活性判不了**（`mode === 'unknown'`）。
  // 故意**不**把 `held` 算进来：暂不动是设计行为（有别的实例在跑 / 自身还新鲜），不是失败。
  out.ok = out.failed.length === 0 && out.mode !== 'unknown';
  return out;
}

/** 一行读数（**唯一一处**文案；`main.js` 只 `console.log(huskSweep.message(out))`）。
 *  三档必须**同时可见**，并且"留着"要连**理由**一起打（B8：只报数字等于没说明）。 */
function message(out) {
  const o = out || {};
  const why = {};
  for (const h of (o.held || [])) why[h.why] = (why[h.why] || 0) + 1;
  const whyText = Object.keys(why).map((k) => k + ' ' + why[k]).join('/');
  const modeText = o.mode === 'idle' ? '盘上没有别的实例 ⇒ 发现即清（自身新鲜期 60s）'
    : o.mode === 'busy' ? '有 ' + o.live + ' 份冒烟在跑 ⇒ 只清超过 3600s 的'
      : '活性判不了（' + (o.error || '登记读不出来') + '）⇒ 只清超过 3600s 的';
  return '[smoke] 启动清扫上一轮的死壳：清掉 ' + (o.swept || []).length + ' 个（' + (o.sweptBytes || 0) + ' 字节）'
    + ' · 暂不动 ' + (o.held || []).length + ' 个' + (whyText ? '（' + whyText + '）' : '')
    + ' · ⚠️ 删不掉 ' + (o.failed || []).length + ' 个'
    + ((o.failed || []).length ? '：' + o.failed.map((f) => f.name + '(' + f.code + ')').join(', ') : '')
    + ' ｜' + modeText
    + (o.reaped ? ' ｜顺手清掉僵尸登记 ' + o.reaped + ' 个' : '');
}

module.exports = {
  HUSK_PREFIX, LIVE_DIR_NAME, CLAIM_PREFIX, SAFE_AGE_MS, SELF_FRESH_MS, MAX_CLAIM_AGE_MS,
  claimNameFor, parseClaimName, makeClaim, liveClaims, sweepHusks, treeBytes, message
};
