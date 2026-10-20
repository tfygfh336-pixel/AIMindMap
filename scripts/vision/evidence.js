#!/usr/bin/env node
/* ============================================================
 * scripts/vision/evidence.js — L4 读图证据的**落盘 / 完整性判定 / 清理**（唯一实现）
 * ------------------------------------------------------------
 * **存在的唯一理由（台账 `G-07` 原话）**：「让 L4 读图证据真的落盘（`.review/vision/` 现在不存在）」。
 *
 * 动手前实测到的现状（不是猜的）：
 *   · **截图**由 `main.js` 的冒烟收尾段写，落点是**工程根**的 `smoke-shot.png` +
 *     旁路取景记录 `smoke-frame.json` —— 二者**每次全量冒烟都被覆盖**，而且 `smoke-shot.png`
 *     是工程根上唯一的二进制产物（不进 `.review/`）。⇒ 画面证据只活在"最后一次运行"里，
 *     上一轮长什么样**无从追溯**。
 *   · `scripts/vision/record.js` 会往 `.review/vision/` 写**读图结论**（人/AI 的逐项判定），
 *     但它 **a.** 要人手敲参数（没人敲就没有）、**b.** 记录里只有 sha256，**图本身从来没被归档**
 *     ⇒ 记录绑定的那张图只存在于工程根那一份可被覆盖的 `smoke-shot.png` 上。
 *     ⇒ 所以 `.review/vision/` 从来没被创建过，L4 这条线实际上是**空转**的。
 *
 * 本模块补的正是这一跳：**把"这一次判过的那一帧"连同它的读数一起钉到 `.review/vision/`**，
 * 并给出一条**能分辨"真证据"与"假证据"**的判据。
 *
 * ## 命名（可追溯：时间戳 / 档位 / 范围）
 *   `<YYYYMMDD-HHMMSS>-<tier>-<scope>-L4.png`  ← 截图本体（**原样字节**，不重编码）
 *   `<YYYYMMDD-HHMMSS>-<tier>-<scope>-L4.json` ← 读数（分辨率 / 字节 / sha256 / 像素统计 / 档位 / 范围）
 *   `tier`  = `full`（本工程**只有全量档**才会截图：`roi.run()` 只在 `filtered === false` 时被调用，
 *             快档走 `SMOKE_ONLY` 通道、`main.js` 明确跳过截图 —— 所以它是**构造保证**，不是猜的）
 *   `scope` = `all`（同上：全量档 = 全部冒烟域）。本工程的取景是**整轮一张**（`main.js` 只截一次、
 *             L2 视觉断言复用同一帧），所以这两个字段现在都是常量；把它们**写进名字**是为了将来
 *             真做"逐域取景"时不必改命名规则（改规则 = 旧记录全部认不出）。
 *
 * ## 证据完整性判据（**判的是"对得上"，不是"文件存在"**）
 * ⚠️ 这条判据的写法是照着本工程踩过的坑定的：门禁 G8 第 ⑨ 条曾经「规则要状态词、实现只判文件存在」，
 * 于是**任意一个空文件都能让它变绿**。所以这里**没有一条**是"存在即通过"：
 *   ① **截图在**：`<名>.png` 存在，且是**合法 PNG**（8 字节签名 + IHDR 能读出宽高）；
 *   ② **读数在**：`<名>.json` 存在，且能被 `JSON.parse`，且带齐 `sha256` / `pngBytes` / `width` /
 *      `height` / `stats`（**statstics 的 px 与 unique 必须是数** —— 空 `{}` 不算读数）；
 *   ③ **对得上**（三项，全部由**独立来源**重算，不拿 json 自证）：
 *      `json.sha256` == 磁盘上这张 png 的 sha256；`json.pngBytes` == 文件字节数；
 *      `json.width/height` == **PNG IHDR 里读出的**宽高；
 *   ④ **自洽**：`json.name` == 文件名（前半段），`json.tier`/`json.scope` 与文件名一致。
 * 任一条不满足 ⇒ **判红并逐条点名**（缺图 / 缺读数 / 读数不完整 / 哈希不符 / 尺寸不符 / 字节不符 / 名字不符）。
 *
 * ## 边界（必须诚实标注 —— 与 `testing-for-ai` B7 同一条纪律）
 *   · **不判**"画面对不对"（那正是阶梯里 L4 **无法自动判定**、只能靠纪律 + 人复核的那一半）；
 *   · **不判**两帧之间的差异（L3 基线差率本工程未落地）；
 *   · **不判**帧内容是否空/纯色 —— 那是 **L1**（`frame-stats.passValidFrame`）的判定，
 *     在这里重判会让同一个缺陷报两遍，也会把"有意留白"误判成证据造假（`H3b` 的第三态）。
 *     `stats` 只被**如实报告**，不参与判红。
 *   · **不认识的同名文件不判红**：`.review/vision/` 里文件名不符合本模块命名的（例如
 *     `scripts/vision/record.js` 写的 `<时间>-<主题>.json` 读图结论）一律**只报告、不判红** ——
 *     它们不是"截图证据对"，按同一把尺子量会造**必然假红**（而必然假红等于没有门禁）。
 *
 * ## 三态（照 `testing-for-ai` B8：跳过必须与通过可区分）
 *   **判红**（problems 非空）· **只报告**（未识别的文件 / 帧统计读数）· **跳过**（目录不存在或 0 条记录
 *   —— 打印"没取证"，**不冒充通过**）。
 *
 * ## 清理策略（**唯一数字在这里**，规则写进 `docs/RULES.md`）
 *   `.review/vision/` 会**越积越大**（一帧 ~120 KB）。口径：**保留最近 `KEEP` 对，超了删最旧**，
 *   删除**成对**进行（png 与 json 一起删，绝不留下半对 —— 半对会被完整性判据抓住，等于自己制造红）。
 *   时机：**每次归档成功之后立即执行**（自维护，不需要人记得）；也可 `--prune` 手工跑。
 *   ⚠️ **不删刚写的那一对**（按时间戳升序删最旧，最新的天然留下）。
 *
 * ## 落盘格式（`G1` 会扫 `.review/`）
 *   `.json` 用 `fs.writeFileSync(..., 'utf8')` 写（**UTF-8 无 BOM**）；`.png` 是二进制原样字节。
 *   **绝不**用 PowerShell 的 `>` / `Out-File` / `Set-Content` 写这里的任何文本 —— 那会落 UTF-16LE 或带 BOM，
 *   让 verify 的第 1 步（G1 编码完整性）直接红。
 *
 * 用法：
 *   node scripts/vision/evidence.js --check [--dir <目录>]        # 完整性门禁（exit 0/1）
 *   node scripts/vision/evidence.js --archive --png <x.png> --frame <smoke-frame.json> [--tier full] [--scope all]
 *   node scripts/vision/evidence.js --list [--dir <目录>]          # 逐条读数
 *   node scripts/vision/evidence.js --prune [--keep N]             # 手工清理
 * 退出码：0 = 通过 / 已归档；1 = 完整性判红或参数非法（**采不到真值也算红**）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
/** 落盘目录（相对仓库根）——**工作产物区**，不进 §5 登记、不进 G6 数字扫描、已 gitignore。 */
const OUT_DIR = path.join('.review', 'vision');
/** 保留对数（清理策略的唯一数字；理由见文件头「清理策略」）。 */
const KEEP = 20;
/**
 * 合法档位 / 范围的取值（写进文件名）。
 * `fast` 不会出现在证据里（快档不截图），保留它是为了**让非法值当场暴露**而不是被静默接受。
 */
const TIERS = Object.freeze(['full']);
const SCOPES_RE = /^(all|dom\d+(-[a-z0-9]+)*)$/;

const EXT_PNG = '.png';
const EXT_JSON = '.json';
/** 记录文件名（不含扩展名）：`<YYYYMMDD-HHMMSS>-<tier>-<scope>-L4` */
const BASE_RE = /^(\d{8}-\d{6})-([a-z]+)-([a-z0-9-]+)-L4$/;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const pad2 = (n) => String(n).padStart(2, '0');

/** `Date` → `YYYYMMDD-HHMMSS`（本地时区；文件名人类可读优先于 UTC 可比性 —— 记录里另有 ISO 的 `at`） */
function stampOf(at) {
  const d = at instanceof Date ? at : new Date(at === undefined ? Date.now() : at);
  return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate())
    + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

/**
 * 生成记录基名（**纯函数**）。
 * @param {{at?:Date|number, tier?:string, scope?:string}} [o]
 * @returns {string} `<stamp>-<tier>-<scope>-L4`
 */
function buildName(o) {
  const opt = o || {};
  const tier = opt.tier === undefined ? 'full' : String(opt.tier);
  const scope = opt.scope === undefined ? 'all' : String(opt.scope);
  if (TIERS.indexOf(tier) < 0) throw new Error('evidence: 非法档位 `' + tier + '`（只允许 ' + TIERS.join(' / ') + '）');
  if (!SCOPES_RE.test(scope)) throw new Error('evidence: 非法范围 `' + scope + '`（形如 all 或 dom45 / dom45-47）');
  return stampOf(opt.at === undefined ? Date.now() : opt.at) + '-' + tier + '-' + scope + '-L4';
}

/** 基名 → `{stamp, tier, scope}`；不合法返回 null（**不抛**：调用方拿它区分"记录"与"别的文件"）。 */
function parseName(base) {
  const m = BASE_RE.exec(String(base || ''));
  return m ? { stamp: m[1], tier: m[2], scope: m[3] } : null;
}

/**
 * 从 PNG 字节里读宽高（只读 IHDR，不解码像素 —— 工程零必需依赖，不引 PNG 库）。
 * 这是**独立于读数的第二来源**：`json.width/height` 要跟它对上，而不是跟 json 自己自证。
 * @returns {{ok:boolean, width?:number, height?:number, reason?:string}}
 */
function pngHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33) return { ok: false, reason: '字节数不足 33（连签名 + IHDR 都不够）' };
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return { ok: false, reason: 'PNG 签名不符（前 8 字节不是 \\x89PNG\\r\\n\\x1a\\n）' };
  // 0..7 签名 · 8..11 长度 · 12..15 'IHDR' · 16..19 宽 · 20..23 高
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') return { ok: false, reason: "第 12–15 字节不是 'IHDR'" };
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) return { ok: false, reason: 'IHDR 里的宽或高为 0' };
  return { ok: true, width: width, height: height };
}

/** 读数是否"真的是一份读数"（**不是"文件存在就算"**：空 `{}` 也要被抓出来）。 */
function readingsProblems(json) {
  const p = [];
  if (!json || typeof json !== 'object' || Array.isArray(json)) return ['读数不是对象'];
  if (typeof json.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(json.sha256)) p.push('读数里没有合法的 sha256（64 位小写十六进制）');
  if (typeof json.pngBytes !== 'number' || !(json.pngBytes > 0)) p.push('读数里没有合法的 pngBytes（正整数）');
  if (typeof json.width !== 'number' || !(json.width > 0)) p.push('读数里没有合法的 width');
  if (typeof json.height !== 'number' || !(json.height > 0)) p.push('读数里没有合法的 height');
  const st = json.stats;
  if (!st || typeof st !== 'object' || typeof st.px !== 'number' || typeof st.unique !== 'number') {
    p.push('读数里没有像素统计（stats.px / stats.unique 必须是数）—— 只有 sha256 不算"有读数"');
  }
  return p;
}

/**
 * 把 `smoke-frame.json`（`main.js` 写的取景记录）升格成一条证据读数。
 * **纯函数**：不进文件系统，便于单测。
 * @param {{frame:object, name:string, pngSha:string, pngBytes:number, header:object, at:string, tier:string, scope:string}}
 * @returns {object} 要落盘的读数对象
 */
function buildReadings(input) {
  const f = input.frame || {};
  const st = f.stats || {};
  return {
    _comment: 'L4 读图证据的**读数**。与同名 .png 是一对：sha256 / pngBytes / width·height 三项'
      + '都由 scripts/vision/evidence.js 的 --check **独立重算**并逐项比对（不是"文件存在即通过"）。'
      + '本文件是工作产物（.review/ 可整目录删除），不是跨迭代比对键。',
    schema: 1,
    name: input.name,
    at: input.at,
    archivedAt: input.archivedAt,
    tier: input.tier,
    scope: input.scope,
    png: input.name + EXT_PNG,
    sha256: input.pngSha,
    pngBytes: input.pngBytes,
    width: input.header.width,
    height: input.header.height,
    stats: {
      px: st.px, unique: st.unique, mean: st.mean, variance: st.variance,
      range: st.range, n: st.n, sampled: st.sampled
    },
    statsSource: 'main.js 取景段（frame-stats.analyzeFrame 的返回，经 smoke-frame.json 转来）',
    smoke: {
      assertions: f.smokeAssertions === undefined ? null : f.smokeAssertions,
      unverified: f.smokeUnverified === undefined ? null : f.smokeUnverified,
      visionAssertions: f.visionAssertions === undefined ? null : f.visionAssertions
    }
  };
}

/* ================================================================
 * 归档
 * ================================================================ */

/**
 * 记录时刻：**取截图文件的 mtime**，不是"归档这一刻"。
 * 为什么：文件名要回答的是"**这张图是什么时候拍的**"（可追溯到哪一次运行），
 * 归档动作可能晚几分钟（手工补归档时甚至晚几天）。显式给 `at` 时以它为优先。
 */
function pickStamp(opt, pngPath) {
  if (opt && opt.at !== undefined) return opt.at;
  try { return fs.statSync(pngPath).mtime; } catch (e) { return new Date(); }
}

/**
 * 把一对「截图 + 取景记录」归档进 `<dir>/<base>.png` / `<dir>/<base>.json`。
 *
 * **先判后写**：写之前就把 sha256 / 字节数 / IHDR 宽高三项对上，对不上就**拒绝写**
 * （否则等于亲手往证据库塞一条对不上的记录，而判据要到下一次运行才会红）。
 *
 * @param {{pngPath:string, framePath:string, dir?:string, tier?:string, scope?:string, at?:Date}} o
 * @returns {{ok:boolean, base?:string, dir?:string, pruned?:Array<string>, problems?:Array<string>}}
 */
function archiveFromFrame(o) {
  const opt = o || {};
  const problems = [];
  const dir = opt.dir ? path.resolve(opt.dir) : path.join(ROOT, OUT_DIR);
  let pngBuf = null;
  let frame = null;
  try { pngBuf = fs.readFileSync(opt.pngPath); } catch (e) { problems.push('读不到截图 ' + opt.pngPath + '：' + e.message); }
  try { frame = JSON.parse(fs.readFileSync(opt.framePath, 'utf8')); }
  catch (e) { problems.push('读不到/读不懂取景记录 ' + opt.framePath + '：' + e.message); }
  if (problems.length) return { ok: false, problems };

  const header = pngHeader(pngBuf);
  if (!header.ok) return { ok: false, problems: ['截图不是合法 PNG：' + header.reason] };
  const pngSha = sha256(pngBuf);
  // 三项**先对上**（任何一项不符都不许落盘）
  if (frame.sha256 !== pngSha) {
    problems.push('取景记录与截图**对不上**：记录说 sha256=' + String(frame.sha256).slice(0, 16)
      + '…，而截图实际是 ' + pngSha.slice(0, 16) + '…（张冠李戴：记录会绑到一张不是它的图上）');
  }
  if (frame.bytes !== pngBuf.length) problems.push('字节数不符：记录说 ' + frame.bytes + '，实际 ' + pngBuf.length);
  if (frame.width !== header.width || frame.height !== header.height) {
    problems.push('分辨率不符：记录说 ' + frame.width + 'x' + frame.height
      + '，PNG IHDR 说 ' + header.width + 'x' + header.height);
  }
  if (problems.length) return { ok: false, problems };

  const capturedAt = pickStamp(opt, opt.pngPath);
  const base = buildName({ at: capturedAt, tier: opt.tier, scope: opt.scope });
  fs.mkdirSync(dir, { recursive: true });
  const pngOut = path.join(dir, base + EXT_PNG);
  const jsonOut = path.join(dir, base + EXT_JSON);
  // 二进制原样字节；不进任何重编码（重编码会改字节 ⇒ 破坏"同一次采集"的同一性）
  fs.writeFileSync(pngOut, pngBuf);
  const readings = buildReadings({
    frame: frame, name: base, pngSha: pngSha, pngBytes: pngBuf.length, header: header,
    // `at` = **采集时刻**（与文件名同一个来源）；归档动作本身另记 `archivedAt`
    at: new Date(capturedAt).toISOString(),
    archivedAt: new Date().toISOString(),
    tier: opt.tier === undefined ? 'full' : String(opt.tier),
    scope: opt.scope === undefined ? 'all' : String(opt.scope)
  });
  // ⚠️ utf8 无 BOM —— `.review/` 会被 G1（编码门禁）扫
  fs.writeFileSync(jsonOut, JSON.stringify(readings, null, 2) + '\n', 'utf8');
  const pruned = prune({ dir: dir, keep: opt.keep === undefined ? KEEP : opt.keep });
  return { ok: true, base: base, dir: dir, png: pngOut, json: jsonOut, pruned: pruned.removed };
}

/* ================================================================
 * 完整性判定
 * ================================================================ */

/**
 * 判定一整个证据目录（**纯 I/O，判定逻辑不掺别的**）。
 *
 * @param {{dir?:string}} [o]
 * @returns {{ok:boolean, skipped:boolean, dir:string, records:Array<object>, ignored:Array<object>,
 *   problems:Array<{file:string, kind:string, msg:string}>}}
 *   `skipped` = 目录不存在或 0 条记录（**跳过 ≠ 通过**，调用方必须打印出来）
 */
function judge(o) {
  const opt = o || {};
  const dir = opt.dir ? path.resolve(opt.dir) : path.join(ROOT, OUT_DIR);
  const out = { ok: false, skipped: false, dir: dir, records: [], ignored: [], problems: [] };
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) {
    if (e.code === 'ENOENT') { out.skipped = true; return out; }
    throw e;
  }
  const bases = new Map();   // base -> {png, json}
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name);
    if (ext !== EXT_PNG && ext !== EXT_JSON) { out.ignored.push({ file: e.name, why: '既不是 .png 也不是 .json' }); continue; }
    const base = e.name.slice(0, -ext.length);
    const meta = parseName(base);
    if (!meta) { out.ignored.push({ file: e.name, why: '文件名不符合本模块的命名（<时间戳>-<档位>-<范围>-L4）—— 可能是别的工具写的，不当证据判' }); continue; }
    if (!bases.has(base)) bases.set(base, { png: null, json: null, meta: meta });
    bases.get(base)[ext === EXT_PNG ? 'png' : 'json'] = path.join(dir, e.name);
  }
  if (!bases.size) { out.skipped = true; return out; }

  // 按时间戳升序（文件名可排序）—— 读数顺序稳定，便于人工对账
  const names = [...bases.keys()].sort();
  for (const base of names) {
    const entry = bases.get(base);
    const rec = { name: base, tier: entry.meta.tier, scope: entry.meta.scope, ok: true };
    const add = (kind, msg) => { rec.ok = false; out.problems.push({ file: base, kind: kind, msg: msg }); };
    // ① 截图在
    if (!entry.png) add('no-png', '缺截图：只有读数、没有 `<名>.png` —— 读数描述的图不在，等于没有证据');
    // ② 读数在
    if (!entry.json) add('no-json', '缺读数：只有截图、没有 `<名>.json` —— 图在但没人说得清它是什么，无法对账');
    let pngBuf = null;
    if (entry.png) {
      pngBuf = fs.readFileSync(entry.png);
      const h = pngHeader(pngBuf);
      if (!h.ok) add('png-invalid', '截图不是合法 PNG：' + h.reason);
      else { rec.width = h.width; rec.height = h.height; }
    }
    let json = null;
    if (entry.json) {
      try { json = JSON.parse(fs.readFileSync(entry.json, 'utf8')); }
      catch (e) { add('json-invalid', '读数不是合法 JSON：' + e.message); }
      if (json) {
        for (const p of readingsProblems(json)) add('readings-incomplete', p);
      }
    }
    // ③ 对得上（只有两边都在时才谈得上"对得上"）
    if (pngBuf && json && typeof json === 'object') {
      const actualSha = sha256(pngBuf);
      rec.sha256 = actualSha;
      if (json.sha256 !== actualSha) {
        add('sha-mismatch', '哈希不符：读数说 sha256=' + String(json.sha256).slice(0, 16)
          + '…，而磁盘上这张图的 sha256=' + actualSha.slice(0, 16)
          + '… ⇒ 读数绑的不是这张图（要么图被换过、要么读数被改过）');
      }
      if (json.pngBytes !== pngBuf.length) {
        add('bytes-mismatch', '字节不符：读数说 pngBytes=' + json.pngBytes + '，磁盘上是 ' + pngBuf.length);
      }
      if (rec.width !== undefined && (json.width !== rec.width || json.height !== rec.height)) {
        add('size-mismatch', '尺寸不符：读数说 ' + json.width + 'x' + json.height
          + '，PNG IHDR 说 ' + rec.width + 'x' + rec.height);
      }
    }
    // ④ 自洽
    if (json && typeof json === 'object') {
      if (json.name !== base) add('name-mismatch', '读数的 name（' + json.name + '）与文件名（' + base + '）不一致');
      if (json.tier !== entry.meta.tier) add('tier-mismatch', '读数的 tier（' + json.tier + '）与文件名（' + entry.meta.tier + '）不一致');
      if (json.scope !== entry.meta.scope) add('scope-mismatch', '读数的 scope（' + json.scope + '）与文件名（' + entry.meta.scope + '）不一致');
      if (json.stats) rec.stats = json.stats;
    }
    out.records.push(rec);
  }
  out.ok = out.problems.length === 0;
  return out;
}

/**
 * 清理：**保留最近 keep 对，超了删最旧**；删除成对（png + json 一起）。
 * 只处理**符合本模块命名**的条目 —— 别的文件（例如 `record.js` 的读图结论）一个都不碰。
 * @param {{dir?:string, keep?:number, dryRun?:boolean}} [o]
 * @returns {{removed:Array<string>, kept:number, dir:string}}
 */
function prune(o) {
  const opt = o || {};
  const dir = opt.dir ? path.resolve(opt.dir) : path.join(ROOT, OUT_DIR);
  const keep = Number.isFinite(opt.keep) && opt.keep >= 0 ? opt.keep : KEEP;
  const removed = [];
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return { removed: removed, kept: 0, dir: dir }; }
  const bases = [...new Set(names
    .filter((n) => parseName(n.slice(0, -path.extname(n).length)))
    .map((n) => n.slice(0, -path.extname(n).length)))].sort();
  const over = bases.slice(0, Math.max(0, bases.length - keep));   // 升序 ⇒ 前面的是最旧的
  for (const base of over) {
    for (const ext of [EXT_PNG, EXT_JSON]) {
      const p = path.join(dir, base + ext);
      try { if (!opt.dryRun) fs.unlinkSync(p); removed.push(base + ext); } catch (e) { /* 不在即跳过 */ }
    }
  }
  return { removed: removed, kept: Math.min(bases.length, keep), dir: dir };
}

/* ================================================================
 * 打印
 * ================================================================ */

function printReport(res) {
  const where = path.relative(ROOT, res.dir) || res.dir;
  if (res.skipped) {
    console.log('L4 读图证据：**跳过**（' + where + ' 里没有一条证据记录）——');
    console.log('  ⚠️ 这不是"通过"：没有证据 = 没取证。全量档冒烟（`npm run smoke`）跑一次就会产出。');
    res.ignored.forEach((x) => console.log('  · 未识别（只报告）：' + x.file + ' —— ' + x.why));
    return;
  }
  console.log('L4 读图证据：' + res.records.length + ' 条（' + where + '）'
    + '｜通过 ' + res.records.filter((r) => r.ok).length
    + ' / 判红 ' + res.records.filter((r) => !r.ok).length
    + ' / 未验证 0'
    + (res.ignored.length ? '｜未识别（只报告）' + res.ignored.length : ''));
  for (const r of res.records) {
    const st = r.stats ? ('unique=' + r.stats.unique + ' range=' + (typeof r.stats.range === 'number' ? r.stats.range.toFixed(1) : '?')
      + ' variance=' + (typeof r.stats.variance === 'number' ? r.stats.variance.toFixed(1) : '?')) : 'stats=?';
    console.log('  ' + (r.ok ? '✓' : '✗') + ' ' + r.name + '  ' + (r.width || '?') + 'x' + (r.height || '?')
      + '  ' + st);
  }
  res.ignored.forEach((x) => console.log('  · 未识别（只报告）：' + x.file + ' —— ' + x.why));
  if (res.problems.length) {
    console.error('');
    console.error('✗ L4 读图证据**完整性判红**（' + res.problems.length + ' 条）—— 逐条点名：');
    for (const p of res.problems) console.error('  · [' + p.kind + '] ' + p.file + '：' + p.msg);
    console.error('  怎么办：证据是工作产物（`.review/` 可整目录删）。缺图/缺读数/对不上的那一对，');
    console.error('  要么重跑一次全量档冒烟（`npm run smoke`）重新产出，要么 `node scripts/vision/evidence.js --prune`');
    console.error('  把它按保留策略删掉；**不许**手改读数去迁就截图（那就是造假证据本身）。');
  }
}

function parseargv(argv) {
  const a = { dir: null, keep: null, png: null, frame: null, tier: 'full', scope: 'all', mode: null, allowEmpty: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--check') a.mode = 'check';
    else if (k === '--allow-empty') a.allowEmpty = true;
    else if (k === '--archive') a.mode = 'archive';
    else if (k === '--list') a.mode = 'list';
    else if (k === '--prune') a.mode = a.mode || 'prune';
    else if (k === '--dir') a.dir = argv[++i];
    else if (k === '--keep') a.keep = parseInt(argv[++i], 10);
    else if (k === '--png') a.png = argv[++i];
    else if (k === '--frame') a.frame = argv[++i];
    else if (k === '--tier') a.tier = argv[++i];
    else if (k === '--scope') a.scope = argv[++i];
    else { console.error('error: 未知参数 ' + k); process.exit(1); }
  }
  return a;
}

function main() {
  const a = parseargv(process.argv.slice(2));
  const dir = a.dir ? path.resolve(a.dir) : undefined;
  if (a.mode === 'archive') {
    if (!a.png || !a.frame) { console.error('error: --archive 需要 --png <截图> 与 --frame <取景记录>'); process.exit(1); }
    const r = archiveFromFrame({
      pngPath: path.resolve(a.png), framePath: path.resolve(a.frame),
      dir: dir, tier: a.tier, scope: a.scope, keep: a.keep === null ? undefined : a.keep
    });
    if (!r.ok) {
      console.error('error: 拒绝归档（先判后写：对不上的证据一个字节都不落盘）');
      r.problems.forEach((p) => console.error('  · ' + p));
      process.exit(1);
    }
    console.log('已归档 L4 读图证据：' + path.relative(ROOT, r.png) + '  +  '
      + path.relative(ROOT, r.json));
    if (r.pruned && r.pruned.length) console.log('  清理：按保留策略删掉最旧的 ' + r.pruned.length + ' 个文件（'
      + r.pruned.filter((x) => x.slice(-4) === EXT_PNG).join('、') + '）');
    const j = judge({ dir: r.dir });
    printReport(j);
    process.exit(j.ok ? 0 : 1);
  }
  if (a.mode === 'prune') {
    const p = prune({ dir: dir, keep: a.keep === null ? undefined : a.keep });
    console.log('清理 ' + (path.relative(ROOT, p.dir) || p.dir) + '：保留最近 ' + p.kept + ' 对，删掉 '
      + p.removed.length + ' 个文件' + (p.removed.length ? '（' + p.removed.join('、') + '）' : ''));
    process.exit(0);
  }
  const res = judge({ dir: dir });
  printReport(res);
  if (a.mode === 'list') process.exit(0);
  /* 空目录（一条证据都没有）的收口：**默认判红**。
   * 为什么不能"没有就通过"：那就是**空转门禁**的教科书形状（`testing-for-ai` A5「采不到真值 = 红」）——
   * 一个在"什么都没有"时也绿的判据，等于告诉读者"证据都在"。真正的成因是"还没跑过全量档冒烟"，
   * 而那是**要去做的事**，不是可以放过的事。
   * 只在"我只是想看看现在有没有证据"这种只读场景才用 `--allow-empty`（那时 exit 0 + 明确打印"跳过"，
   * 与"通过"仍可分辨：措辞不同、读数里 `skipped` 为真）。 */
  if (res.skipped) process.exit(a.allowEmpty ? 0 : 1);
  process.exit(res.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  OUT_DIR, KEEP, TIERS, EXT_PNG, EXT_JSON, BASE_RE,
  stampOf, buildName, parseName, pngHeader, readingsProblems, buildReadings,
  archiveFromFrame, judge, prune
};
