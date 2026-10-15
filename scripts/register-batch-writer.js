/* ============================================================
 * scripts/register-batch-writer.js —— CLI/代理**批写者**的「先登记后写」登记口（效率批 3）
 * ------------------------------------------------------------
 * 为什么需要它：「真实数据零写入」守卫（scripts/smoke/real-write-guard.js）原先只认**界面实例**
 * 证据（`.ui-state.json` 的 uiPid）—— CLI/代理批写 `projects/**` 没有 pid 可归因 ⇒ 一律保守判红，
 * 于是"同机并行书批每写一次，全链就红一次" ✗。修法 = **登记式归因**：批写者**先登记、后写**——
 *
 *   node scripts/register-batch-writer.js --name "书批：xxx" [--minutes 90] [--projects-dir <目录>]
 *
 * 它在 `projects/.writers/<批id>.json` 落一份**自报登记**（pid + 批名 + 时间窗）。守卫读到
 * "时间窗盖住写入时刻 且 pid ≠ 冒烟进程"的登记 ⇒ 归给该批（响亮"本次没验（在册批：<id>）"、
 * exit 0）；**没登记的陌生人写 ⇒ 仍红**；**自己（冒烟进程）写 ⇒ 仍红**（pid = 本进程的登记
 * 不给免责 ✗）。登记**过期自动失效**（窗口外）⇒ 没有永久豁免；守卫侧的解释与四条正证据
 * 全部写在 real-write-guard.js 一处（本脚本只是写者的**登记**动作，不做任何归因判断 ✗）。
 *
 * 纪律：写盘 = 唯一出口 `fs.writeFileSync(..., 'utf8')`（无 BOM ✓）；批 id 带时间+pid+随机段
 * （并发唯一 ✗ 不许固定名）；顺手清掉的只有"**已过期**且解析得动"的旧登记（活人的登记、
 * 解析不动的坏文件一律不动 ✗）；不做任何"删别人的登记"或通配清理 ✗。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WRITERS_DIR = '.writers';
const MAX_MINUTES = 14 * 24 * 60;   // CLI 侧的窗上限（14 天；守卫侧的合法上界是 30 天，取更严的那个 ✓）

/** 批 id：名字的净化片段 + 时间 + pid + 随机段（并发唯一 ✗ 不许固定名） */
function buildBatchId(name, pid, nowMs, randHex) {
  const slug = String(name || 'batch').replace(/[^\w.\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'batch';
  const d = new Date(nowMs);
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  return slug + '-' + stamp + '-p' + pid + '-' + String(randHex || crypto.randomBytes(2).toString('hex'));
}

/** 纯函数：构造登记对象（字段语义的唯一出处；守卫按这里的四个必填字段校验） */
function buildRegistration(opts) {
  const o = opts || {};
  const nowMs = typeof o.nowMs === 'number' ? o.nowMs : Date.now();
  const minutes = Math.max(1, Math.min(MAX_MINUTES, Number(o.minutes) || 90));
  const name = String(o.name || '').trim();
  if (!name) throw new Error('必须给 --name <批名>（守卫要求豁免带原因 ✗）');
  const pid = typeof o.pid === 'number' ? o.pid : process.pid;
  if (!(pid > 0)) throw new Error('pid 必须是正数');
  return {
    schemaVersion: 1,
    batchId: o.batchId || buildBatchId(name, pid, nowMs, o.randHex),
    pid,
    batchName: name.slice(0, 80),
    windowStartMs: nowMs,
    windowEndMs: nowMs + minutes * 60000,
    registeredAt: new Date(nowMs).toISOString()
  };
}

/** 纯函数：给定一批登记读数，挑出"已过期超过 grace"的 id（只挑解析得动的 ✗ 坏文件不动） */
function expiredIds(entries, nowMs, graceMs) {
  const grace = typeof graceMs === 'number' ? graceMs : 60 * 60000;
  const out = [];
  for (const en of entries || []) {
    if (!en || typeof en.text !== 'string' || !en.id) continue;
    try {
      const j = JSON.parse(en.text);
      if (j && typeof j.windowEndMs === 'number' && isFinite(j.windowEndMs)
        && j.windowEndMs < nowMs - grace) out.push(en.id);
    } catch (e) { /* 解析不动的不动它（响亮留给守卫去报 ✗） */ }
  }
  return out;
}

function parseArgs(argv) {
  const get = (k) => {
    const i = argv.indexOf('--' + k);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  return {
    name: get('name'),
    minutes: Number(get('minutes') || 90),
    projectsDir: get('projects-dir') || path.join(__dirname, '..', 'projects')
  };
}

function main(argv) {
  const a = parseArgs(argv || process.argv);
  const dir = path.join(a.projectsDir, WRITERS_DIR);
  const nowMs = Date.now();
  /* 顺手清理：只删"已过期超过 1 小时 且 解析得动"的旧登记（读数响亮；活人/坏文件一律不动 ✗） */
  let cleaned = [];
  try {
    const names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.json$/.test(e.name)).map((e) => e.name);
    const entries = names.map((n) => ({ id: n.slice(0, -5), text: (() => {
      try { return fs.readFileSync(path.join(dir, n), 'utf8'); } catch (e) { return null; }
    })() }));
    cleaned = expiredIds(entries, nowMs);
    for (const id of cleaned) { try { fs.unlinkSync(path.join(dir, id + '.json')); } catch (e) { /* 别人的写窗，下一轮再说 */ } }
  } catch (e) { /* 目录还不存在 = 第一次登记，没有可清理的 */ }
  fs.mkdirSync(dir, { recursive: true });
  const reg = buildRegistration({ name: a.name, minutes: a.minutes, nowMs, pid: process.pid });
  const file = path.join(dir, reg.batchId + '.json');
  if (fs.existsSync(file)) throw new Error('批 id 撞了（' + reg.batchId + '）—— 换一次再登记 ✗');
  fs.writeFileSync(file, JSON.stringify(reg, null, 2) + '\n', 'utf8');
  /* 写后回读验证（E2：落盘必须验过才算登记完成） */
  JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log('[batch-writer] 已登记（先登记后写 ✓）：' + reg.batchId);
  console.log('  · 批名=' + reg.batchName + ' pid=' + reg.pid);
  console.log('  · 窗口=' + reg.windowStartMs + ' → ' + reg.windowEndMs
    + '（' + new Date(reg.windowEndMs).toISOString() + ' 过期自动失效；现在到到期共 '
    + Math.round((reg.windowEndMs - reg.windowStartMs) / 60000) + ' 分钟）');
  console.log('  · 文件=' + file);
  if (cleaned.length) console.log('  · 顺手清掉过期登记 ' + cleaned.length + ' 份（只删已过期且解析得动的 ✓）：' + cleaned.join('、'));
  console.log('  · 接下来才许写 projects/**；写完可自删登记文件（不删也会过期自动失效 ✓）');
  console.log('  · 守卫侧口径（四条正证据 + 判别力）：scripts/smoke/real-write-guard.js 一处 ✓');
}

if (require.main === module) main();
module.exports = { WRITERS_DIR, MAX_MINUTES, buildBatchId, buildRegistration, expiredIds, parseArgs };
