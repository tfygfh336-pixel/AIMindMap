/* ============================================================
 * scripts/smoke/real-write-guard.js —— 「真实数据零写入」的**三档归因**（纯函数，可单测）
 * ------------------------------------------------------------
 * 为什么需要它（实测的形状）：冒烟跑在沙箱副本上，主进程在跑完时复核**真实** `projects/**`
 * 有没有被动过。这条判据原先只有两档 —— **变了就判红**。而"同机有人正开着这个应用"是最普通的
 * 情形，那个实例会一直写自己的 `projects/<项目>/.ui-state.json` ⇒ **必然假红**；而长期挂红的
 * 门禁下场是被无视（连真红也不看 ✗）。
 *
 * 三档（档数**必须够**：把"环境有他人写入"读成产品缺陷、或反过来读成通过，是最坏的两头）：
 *   ① `leak`        —— 有**本次自己写的**正证据（或无法排除是本进程）⇒ **判红**（冒烟必须零写入）；
 *   ② `unverified`  —— 有**不是本次写的**正证据 ⇒ **"本次没验"**：响亮打印、不参与计数、不阻断、
 *                      也**不当产品缺陷**（skill §G 第 4 条"环境给不出 ≠ 我们没做到"）；
 *   ③ `error`       —— 真值采不到（探针/复核自己失败）⇒ **判红**（采不到真值不能自称已校验 ✗）。
 *
 * 「不是本次写的」四条正证据（每条都能独立成立，逐文件判定；**判据写在这一处**）：
 *   ⓐ **写入者 pid**：文件里记着写入者的 pid（`.ui-state.json` 的 `uiPid` 就是这种形态）且
 *      **不等于本进程 pid** ⇒ 这份不是本次的冒烟进程写的。⚠️ 判据只认"不等"，不认"是否还活着"
 *      —— 我们的进程此刻必然活着，而那个 pid 不是我们 ⇒ 无论它后来有没有退出，都不是本次写的 ✓；
 *   ⓑ **时间戳落在本次运行窗口之外**：本进程写盘不可能产生"早于快照"或"晚于复核"的时间戳
 *      （`cpSync` 那样保留时间戳的**搬入/覆盖**是真实存在的来源）⇒ 是别处来的；
 *   ⓒ **环境里还有另一个活着的界面实例**（探针扫真实 `projects/<项目>/.ui-state.json` 的 `uiPid`：
 *      存活且不是本进程）⇒ 真实目录此刻**有别的写者**，无法把差异归给本次 ⇒ 不判红。
 *      这一条**只在没有 ⓐ/ⓑ 证据时**才用于免责：有本进程 pid 正证据的，照旧判红 ✓；
 *   ⓓ **在册批**（效率批 3 · 2026-10-16）：CLI/代理**批写者没有界面实例可归因**（无 `.ui-state.json`）
 *      ⇒ 它们按「先登记后写」把**自报登记**（pid + 批名 + 时间窗）落进 `projects/.writers/<批id>.json`，
 *      守卫读登记表：**时间窗盖住该次写入时刻**且 **pid ≠ 本进程** ⇒ 归给该批（响亮"本次没验（在册批：<id>）"）。
 *      失效机制 = **窗口**：窗口外自动失效 ⇒ **没有永久豁免** ✗；pid = 本进程的登记**不给免责**
 *      （自己写 ⇒ 仍红 ✗）——登记是写者**自报**的，守卫只认"窗口内 + 非本进程"这两条硬条件。
 *
 * 边界（如实写明）：ⓒ/ⓓ 是"免责"而非"证明" —— 别人在写的时候，若本次**也**写了，这一层看不出来
 * （缺可归因的正证据）；所以它们只降档为"本次没验"并**给出重跑前提**（关掉那个实例 / 等在册批过期），
 * 而不是判成通过 ✓。反过来，ⓐ/ⓑ/ⓒ/ⓓ 都不成立时**一律按本次算（判红）**——保守方向是红。
 * ⚠️ ⓓ 的登记**在门禁侧解释**（本文件是判据唯一处 + `parseWriterRegistry` 是唯一校验口）：
 * 被检查方在自己进程里写一份登记**不算数**（pid = 本进程的不给免责），坏 JSON / 字段不全 / 窗口
 * 超过 30 天的条目**按无效处理**（记一行读数、不给豁免）✗。
 * ============================================================ */
'use strict';

/** 档位的中文名（打印与报告都用这一份，不在别处再写一遍） */
const VERDICTS = {
  ok: '通过（真实目录逐字节一致）',
  leak: '判红（有本次写入的证据）',
  unverified: '本次没验（环境有他人写入）',
  error: '判红（真值采不到）'
};

/** 批登记目录（真实 projects 根下；门禁侧的豁免台账 ⇒ 不算项目数据、不进指纹、gitignore ✗） */
const WRITERS_DIR = '.writers';
/** 登记时间窗的**合法上界**：超过它按无效处理 ⇒ 防"开一个十年窗口 = 永久豁免" ✗ */
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** 该批在时刻 t 是否"生效"（窗口盖住 t）。t 缺省（removed 文件没有 mtime）⇒ 由调用方走窗口重叠那一档 */
function batchActiveAt(batch, t) {
  return typeof t === 'number' && t >= batch.windowStartMs && t <= batch.windowEndMs;
}

/** 该批的时间窗与运行窗口 [w0, w1] 是否重叠（t 采不到时的兜底归因档） */
function batchOverlaps(batch, w0, w1) {
  return batch.windowStartMs <= w1 && batch.windowEndMs >= w0;
}

/**
 * 解析批登记表（**纯函数**：IO 由调用方做完传进来，与 probeForeignWriters 同形）。
 * 校验（唯一口径；坏条目**记一行读数、不给豁免** —— 保守方向是红）：
 *   · JSON 可解析且是对象；`pid` 数字 > 0；`batchName` 非空串（B8：豁免必须带原因）；
 *   · `windowStartMs` ≤ `windowEndMs` 都是有限数字，且窗口 ≤ MAX_WINDOW_MS（防永久豁免 ✗）。
 * `foreign` 只表示"pid 不是本进程"（与 ⓐ 同一判据）；**活性不进免责条件** —— 批写者写完就退出
 * 是常态，失效机制是**窗口**（过期自动失效 ⇒ 不留永久豁免），`alive` 只进打印读数 ✓。
 * @param {Array<{id:string, text:string|null}>} files 登记文件（id = 文件名去 .json，唯一）
 * @param {{isAlive?:function, ourPid?:number, nowMs?:number}} [opts]
 * @returns {{batches:Array<{id:string,pid:number,name:string,windowStartMs:number,windowEndMs:number,foreign:boolean,alive:boolean,expired:boolean}>, errors:string[]}}
 */
function parseWriterRegistry(files, opts) {
  const o = opts || {};
  const our = o.ourPid === undefined ? process.pid : o.ourPid;
  const alive = o.isAlive || defaultAlive;
  const nowMs = typeof o.nowMs === 'number' ? o.nowMs : Date.now();
  const batches = [];
  const errors = [];
  for (const f of files || []) {
    const id = (f && f.id) || '?';
    if (!f || typeof f.text !== 'string') { errors.push('在册批 ' + id + '：读不到内容 ⇒ 按无效处理（不给豁免）'); continue; }
    let j = null;
    try { j = JSON.parse(f.text); } catch (e) {
      errors.push('在册批 ' + id + '：不是合法 JSON（' + String((e && e.message) || e).slice(0, 60) + '）⇒ 按无效处理（不给豁免）');
      continue;
    }
    const pid = j && typeof j.pid === 'number' && isFinite(j.pid) && j.pid > 0 ? j.pid : null;
    const name = j && typeof j.batchName === 'string' && j.batchName.trim() ? j.batchName.trim().slice(0, 80) : null;
    const w0 = j && typeof j.windowStartMs === 'number' && isFinite(j.windowStartMs) ? j.windowStartMs : null;
    const w1 = j && typeof j.windowEndMs === 'number' && isFinite(j.windowEndMs) ? j.windowEndMs : null;
    if (pid === null || name === null || w0 === null || w1 === null || w1 < w0 || w1 - w0 > MAX_WINDOW_MS) {
      errors.push('在册批 ' + id + '：字段不全或窗口非法（要 pid>0 · batchName · 0 ≤ windowEndMs−windowStartMs ≤ '
        + MAX_WINDOW_MS + '）⇒ 按无效处理（不给豁免）');
      continue;
    }
    batches.push({ id, pid, name, windowStartMs: w0, windowEndMs: w1,
      foreign: pid !== our, alive: !!alive(pid), expired: w1 < nowMs });
  }
  return { batches, errors };
}

/**
 * 环境准入探针（**独立于产品链路**：直接读真实目录里的旁挂文件，不问产品要结论）。
 * @param {Array<{project:string, stateText:string|null}>} entries 每个项目的 `.ui-state.json` 原文
 * @param {{isAlive?:function, ourPid?:number}} [opts] `isAlive` 注入（便于单测）
 * @returns {{writers:Array<{project:string,uiPid:number,alive:boolean,foreign:boolean}>, foreignAlive:number[], errors:string[]}}
 */
function probeForeignWriters(entries, opts) {
  const o = opts || {};
  const our = o.ourPid === undefined ? process.pid : o.ourPid;
  const alive = o.isAlive || defaultAlive;
  const writers = [];
  const errors = [];
  for (const e of entries || []) {
    const text = e && e.stateText;
    if (!text) continue;                       // 没这份文件 = 那个项目没有界面状态 ⇒ 不是"有人在写"的证据
    let pid = null;
    try {
      const j = JSON.parse(text);
      pid = j && typeof j.uiPid === 'number' ? j.uiPid : null;
    } catch (err) { errors.push('（' + (e.project || '?') + ' 的 `.ui-state.json` 读不成 JSON：'
      + String((err && err.message) || err).slice(0, 80) + '）'); continue; }
    if (pid === null || pid <= 0) continue;
    writers.push({ project: e.project || '?', uiPid: pid, alive: !!alive(pid), foreign: pid !== our });
  }
  return {
    writers,
    foreignAlive: writers.filter((w) => w.foreign && w.alive).map((w) => w.uiPid),
    errors
  };
}

/** 默认活性判定（与 src/ui-state.js 同一形态：EPERM 也算活着） */
function defaultAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

/**
 * 归因（纯函数）。输入全部由调用方现算后传进来。
 * @param {Array<{rel:string,kind:'changed'|'added'|'removed',mtimeMs?:number|null,writerPid?:number|null,stampMs?:number|null}>} changes
 * @param {{ourPid?:number, windowStartMs:number, windowEndMs:number, othersAlive?:number[], registeredBatches?:Array, probeError?:string|null}} env
 * @returns {{verdict:'ok'|'leak'|'unverified'|'error', items:Array, counts:object, reason:string}}
 */
function classifyRealWrites(changes, env) {
  const e = env || {};
  const our = e.ourPid === undefined ? process.pid : e.ourPid;
  const others = e.othersAlive || [];
  const reg = e.registeredBatches || [];
  const usedReg = {};
  const items = [];
  const counts = { changed: 0, added: 0, removed: 0, foreign: 0, ours: 0, unknown: 0, inRegistry: 0 };
  if (e.probeError) {
    return { verdict: 'error', items: [], counts, registryIds: [],
      reason: '复核本身取不到真值：' + e.probeError + ' ⇒ 不能自称已校验（采不到真值 = 红 ✗）' };
  }
  for (const c of changes || []) {
    if (c.kind === 'changed' || c.kind === 'added' || c.kind === 'removed') counts[c.kind] += 1;
    const stamp = (c.stampMs === undefined || c.stampMs === null) ? c.mtimeMs : c.stampMs;
    // 在册批归因（ⓓ）：t 采得到 ⇒ 窗口盖住 t；t 采不到（removed 文件没有 mtime）⇒ 退到与运行窗口重叠。
    // 两个候选都命中时**本进程的登记优先**（"自己写 ⇒ 仍红"是保守方向 ✗ 不许被别人的登记洗掉）。
    const at = (b) => (typeof stamp === 'number' ? batchActiveAt(b, stamp) : batchOverlaps(b, e.windowStartMs, e.windowEndMs));
    const regOurs = reg.filter((b) => !b.foreign && at(b))[0] || null;
    const regForeign = reg.filter((b) => b.foreign && at(b))[0] || null;
    let verdict = 'leak';
    let why = '';
    if (typeof c.writerPid === 'number' && c.writerPid > 0) {
      if (c.writerPid === our) { why = '写入者 pid = 本进程（' + our + '）'; }
      else { verdict = 'unverified'; why = '写入者 pid = ' + c.writerPid + '（**不是**本进程 ' + our + '）'; }
    } else if (typeof stamp === 'number' && stamp < e.windowStartMs) {
      verdict = 'unverified'; why = '时间戳 ' + new Date(stamp).toISOString()
        + ' 早于本次运行窗口开始（' + new Date(e.windowStartMs).toISOString() + '）—— 本进程写不出这种时间戳';
    } else if (typeof stamp === 'number' && stamp > e.windowEndMs) {
      verdict = 'unverified'; why = '时间戳 ' + new Date(stamp).toISOString()
        + ' 晚于本次复核时刻（' + new Date(e.windowEndMs).toISOString() + '）—— 本进程写不出"未来"的文件';
    } else if (regOurs) {
      why = '登记表里有 **pid=本进程** 的在册批（' + regOurs.id + '）—— 登记不许给本进程免责（自己写 ⇒ 仍红）⇒ 按本次算';
    } else if (regForeign) {
      verdict = 'unverified';
      usedReg[regForeign.id] = true;
      counts.inRegistry += 1;
      why = '落在**在册批**的时间窗内：' + regForeign.id + '（pid=' + regForeign.pid + '，' + regForeign.name
        + '）—— CLI/代理批写者自报登记（先登记后写）⇒ 本次没验';
    } else if (others.length) {
      verdict = 'unverified'; why = '没有归因证据，但环境里有**另一个活着的界面实例**（pid='
        + others.join(',') + '）也在写这个目录 ⇒ 无法归因到本次';
    } else {
      why = '没有"别人写的"任何正证据（无写入者 pid、时间戳落在本次窗口内、登记表没有盖住它的在册批、也没有别的活实例）⇒ 按本次算';
    }
    if (verdict === 'leak') counts.ours += 1; else counts.foreign += 1;
    items.push({ rel: c.rel, kind: c.kind, verdict, why, writerPid: c.writerPid || null,
      stampMs: typeof stamp === 'number' ? stamp : null });
  }
  const registryIds = Object.keys(usedReg);
  if (!items.length) {
    return { verdict: 'ok', items, counts, registryIds, reason: '真实目录一个字节都没变（也没有新增/删除）' };
  }
  const leak = items.filter((i) => i.verdict === 'leak');
  const foreign = items.filter((i) => i.verdict !== 'leak');
  if (leak.length) {
    return { verdict: 'leak', items, counts, registryIds,
      reason: '有 ' + leak.length + ' 处改动**没有"别人写的"证据** ⇒ 按本次算（冒烟必须零写入 ✗）'
        + (foreign.length ? '；另有 ' + foreign.length + ' 处属他人写入（已单独标注）' : '') };
  }
  return { verdict: 'unverified', items, counts, registryIds,
    reason: '这 ' + foreign.length + ' 处改动都有"不是本次写的"正证据 ⇒ **本次没验**（不计产品缺陷，也不当通过）'
      + '；重跑前提：先关掉同机正在使用本应用的实例（它会一直写自己的 `.ui-state.json`）✓' };
}

/** 汇总行（**三态都要可见**：通过 / 未验证 / 真缺陷，只报"通过"会把没验读成过了 ✗） */
function summaryLines(result, opts) {
  const o = opts || {};
  const c = result.counts || {};
  const lines = [];
  lines.push('真实数据零写入：' + (VERDICTS[result.verdict] || result.verdict)
    + '（改=' + (c.changed || 0) + ' 新增=' + (c.added || 0) + ' 删除=' + (c.removed || 0)
    + ' ⇒ 本次证据 ' + (c.ours || 0) + ' · 他人证据 ' + (c.foreign || 0) + '）');
  lines.push('理由：' + result.reason);
  for (const i of result.items || []) {
    lines.push('  · ' + i.kind + ' ' + i.rel + ' —— ' + i.why);
  }
  if (o.probe) {
    const w = o.probe.writers || [];
    lines.push('环境探针（独立于产品链路：读真实 `projects/*/.ui-state.json` 的 `uiPid`）：'
      + (w.length ? w.map((x) => x.project + '→pid ' + x.uiPid + (x.alive ? '（活着' : '（已退出')
        + (x.foreign ? '，非本进程）' : '，本进程）')).join(' · ')
        : '（没有一个项目带界面状态 ⇒ 看不出有人在用）')
      + (o.probe.foreignAlive && o.probe.foreignAlive.length
        ? ' ⇒ **有别的实例活着**：' + o.probe.foreignAlive.join(',') : ''));
    (o.probe.errors || []).forEach((x) => lines.push('  · ' + x));
  }
  if (o.registry) {
    const bs = o.registry.batches || [];
    lines.push('在册批 ' + bs.length + ' 个（CLI/代理批写者的**自报登记**：pid + 批名 + 时间窗，先登记后写；'
      + '门禁只认**窗口内**且**非本进程**的 ⇒ 窗口外自动失效，没有永久豁免 ✗）'
      + (bs.length ? '：' : '（登记目录空 ⇒ 本条没有登记可用）'));
    for (const b of bs) {
      lines.push('  · 在册批 ' + b.id + ' pid=' + b.pid + '（' + b.name + '）窗口='
        + new Date(b.windowStartMs).toISOString() + ' → ' + new Date(b.windowEndMs).toISOString()
        + (b.expired ? '（已过期 ⇒ 不给豁免）' : '')
        + (b.foreign ? '' : '（**本进程** ⇒ 不给免责）') + (b.alive ? '' : '（pid 已退出）'));
    }
    (o.registry.errors || []).forEach((x) => lines.push('  · ' + x));
  }
  if (result.verdict === 'unverified') {
    const ids = result.registryIds || [];
    lines.push(ids.length
      ? '⚠️ 这一条**本次没验（在册批：' + ids.join('、') + '）**：不参与计数、不阻断退出码、也不计成产品缺陷 ——'
        + ' 但**不许**读成"通过"（在册批是**免责**不是**证明**：批在写时本次若也写了，这一层看不出来。'
        + '要真绿：等在册批过期/结束、且同机没有界面实例在写，再跑一次）'
      : '⚠️ 这一条**本次没验**：不参与计数、不阻断退出码、也不计成产品缺陷 ——'
        + ' 但**不许**读成"通过"（要它绿：关掉同机正在用这个应用的实例，再跑一次 `npm run smoke`）');
  }
  return lines;
}

module.exports = { classifyRealWrites, parseWriterRegistry, probeForeignWriters, summaryLines, defaultAlive, VERDICTS, WRITERS_DIR, MAX_WINDOW_MS };
