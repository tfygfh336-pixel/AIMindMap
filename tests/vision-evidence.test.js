/* ============================================================
 * tests/vision-evidence.test.js — 台账 `G-07`：
 *   「让 L4 读图证据真的落盘（`.review/vision/` 现在不存在）」
 * ------------------------------------------------------------
 * ## 这个文件守什么
 * 截图归档 + 读数 + **两者对得上** + 保留策略，判定本体全在
 * `scripts/vision/evidence.js`（唯一实现）。这里只做两件事：
 *   ① **正面判据**：一对真证据 ⇒ 绿；一帧真图跑完整条归档路径 ⇒ 图与读数都落盘、字节原样；
 *   ② **判别力证明**：把证据**造假/改坏**成 8 种形态 ⇒ 判据必须**红**（并给出对应问题码）。
 *
 * ## 为什么"造假"要列 8 种（这是本文件存在的核心理由）
 * 门禁 G8 第 ⑨ 条曾经犯过的错是：**规则要状态词、实现只判文件存在** ——
 * 于是任何空文件都能让它变绿。所以这里的每一种注入都对应一类真实的"看起来有证据"：
 *   只有图没读数 · 只有读数没图 · 图被换成另一张 · 读数的 sha 被改 · 读数的宽高被改 ·
 *   读数是空对象 `{}` · 一对**空文件**（"存在即通过"的形状）· 一条记录都没有（**跳过 ≠ 通过**）。
 *
 * ## 不碰真实数据
 * 全部落在 `tests/_tmp-cleanup.js` 登记的临时目录里；**不读写** 工程的 `.review/vision/`
 * （那份是真实证据库，用例往里头写就是污染证据 —— 与"测试不碰真实数据"同一条纪律）。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);
const ev = require('../scripts/vision/evidence.js');
const roi = require('../scripts/vision/roi-assertions.js');

afterAll(cleanupAll);

const tmp = () => makeTmp('mm-vision-ev-');

/* ============================================================
 * 夹具：一张**结构合法的最小 PNG**
 * ------------------------------------------------------------
 * 判定只读「8 字节签名 + IHDR 里的宽高」（工程零必需依赖，不解码像素 ⇒ 不引 PNG 库），
 * 所以夹具只要满足这一条就够 —— 但 IHDR 的 CRC 仍算对，免得夹具本身是个畸形块。
 * ============================================================ */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
/** @param {number} width @param {number} height @param {number} salt 让"两张同尺寸不同内容"可造 */
function makePng(width, height, salt) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idatData = Buffer.from([0x78, 0x9c, 0x01, 0x02, 0x03].concat(
    Array.from({ length: 24 }, (_, i) => (i * 7 + (salt || 0) * 13) & 0xff)));
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idatData), pngChunk('IEND', Buffer.alloc(0))]);
}

/** 一对"真"证据（图 + 取景记录），返回落盘路径 */
function writePair(dir, o) {
  const opt = o || {};
  const png = opt.png || makePng(opt.width || 40, opt.height || 20, opt.salt || 0);
  const pngPath = path.join(dir, opt.pngName || 'smoke-shot.png');
  fs.writeFileSync(pngPath, png);
  const frame = {
    width: opt.width || 40, height: opt.height || 20,
    bytes: png.length,
    sha256: require('node:crypto').createHash('sha256').update(png).digest('hex'),
    stats: { px: 800, unique: 120, mean: 180.5, variance: 900.25, range: 200, n: 800, sampled: false },
    smokeAssertions: 326, smokeUnverified: 0, visionAssertions: 2
  };
  const framePath = path.join(dir, opt.frameName || 'smoke-frame.json');
  fs.writeFileSync(framePath, JSON.stringify(frame, null, 2) + '\n', 'utf8');
  return { pngPath: pngPath, framePath: framePath, frame: frame };
}

/** 归档一对，返回归档后的目录 */
function archiveOne(o) {
  const opt = o || {};
  const src = tmp();
  const out = opt.out || tmp();
  const pair = writePair(src, opt);
  const r = ev.archiveFromFrame({ pngPath: pair.pngPath, framePath: pair.framePath, dir: out });
  return Object.assign({ src: src, out: out }, pair, { result: r });
}

/* ==================================================================
 * 一、命名（可追溯：时间戳 / 档位 / 范围）
 * ================================================================== */
describe('G-07 · 命名可追溯（含时间戳 / 档位 / 范围）', () => {
  it('基名形如 `<YYYYMMDD-HHMMSS>-<档位>-<范围>-L4`', () => {
    const name = ev.buildName({ at: new Date(2026, 9, 20, 15, 51, 49), tier: 'full', scope: 'all' });
    expect(name).toBe('20261020-155149-full-all-L4');
    expect(ev.BASE_RE.test(name)).toBe(true);
  });

  it('档位 / 范围非法 ⇒ **当场抛**（不许静默落回默认值）', () => {
    expect(() => ev.buildName({ tier: 'fast' })).toThrow(/非法档位/);
    expect(() => ev.buildName({ scope: '随便' })).toThrow(/非法范围/);
  });

  it('`parseName` 只认自家命名 —— 别的工具写的文件不当证据（否则必然假红）', () => {
    expect(ev.parseName('20261020-155149-full-all-L4')).toEqual({ stamp: '20261020-155149', tier: 'full', scope: 'all' });
    // `scripts/vision/record.js` 的读图结论命名（<时间>-<主题>.json）不是截图证据对
    expect(ev.parseName('20261020-1551-细节框改版')).toBe(null);
    expect(ev.parseName('随便')).toBe(null);
  });

  it('归档的文件名 = 截图 **mtime**（可追溯到哪一次运行，不是"归档这一刻"）', () => {
    const a = archiveOne();
    expect(a.result.ok).toBe(true);
    expect(a.result.base.indexOf(ev.stampOf(fs.statSync(a.pngPath).mtime))).toBe(0);
  });
});

/* ==================================================================
 * 二、读数与 PNG 头（判据的两块地基）
 * ================================================================== */
describe('G-07 · 读数必须"真的是读数"、PNG 必须真能读出宽高', () => {
  it('`pngHeader` 从 IHDR 读出宽高（**独立于读数**的第二来源）', () => {
    const h = ev.pngHeader(makePng(40, 20, 0));
    expect(h).toEqual({ ok: true, width: 40, height: 20 });
  });

  it('不是 PNG / 太短 ⇒ `ok:false` 并说明原因（不猜一个尺寸）', () => {
    expect(ev.pngHeader(Buffer.alloc(0)).ok).toBe(false);
    expect(ev.pngHeader(Buffer.from('这不是图片')).ok).toBe(false);
    const truncated = makePng(40, 20, 0).subarray(0, 20);
    expect(ev.pngHeader(truncated).ok).toBe(false);
  });

  it('空 `{}` **不算**读数（"文件存在即通过"正是要防的那件事）', () => {
    const p = ev.readingsProblems({});
    expect(p.length).toBeGreaterThan(0);
    expect(p.join('；')).toMatch(/sha256/);
    expect(p.join('；')).toMatch(/stats/);
  });

  it('完整读数 ⇒ 没有问题；`buildReadings` 把统计量原样带过来', () => {
    const png = makePng(40, 20, 0);
    const sha = require('node:crypto').createHash('sha256').update(png).digest('hex');
    const r = ev.buildReadings({
      frame: { stats: { px: 800, unique: 120, mean: 1, variance: 2, range: 3, n: 800, sampled: true }, smokeAssertions: 7 },
      name: '20261020-155149-full-all-L4', pngSha: sha, pngBytes: png.length,
      header: { width: 40, height: 20 }, at: '2026-10-20T06:00:00.000Z', tier: 'full', scope: 'all'
    });
    expect(ev.readingsProblems(r)).toEqual([]);
    expect(r.stats).toEqual({ px: 800, unique: 120, mean: 1, variance: 2, range: 3, n: 800, sampled: true });
    expect(r.smoke.assertions).toBe(7);
  });
});

/* ==================================================================
 * 三、正面判据：真证据 ⇒ 绿
 * ================================================================== */
describe('G-07 · 真证据 ⇒ 绿', () => {
  it('归档一对 ⇒ png 与读数都在、字节**原样**（不重编码），完整性判绿', () => {
    const a = archiveOne();
    expect(a.result.ok).toBe(true);
    const pngOut = path.join(a.out, a.result.base + ev.EXT_PNG);
    const jsonOut = path.join(a.out, a.result.base + ev.EXT_JSON);
    expect(fs.existsSync(pngOut)).toBe(true);
    expect(fs.existsSync(jsonOut)).toBe(true);
    // 原样字节：重编码会改字节 ⇒ 破坏"同一次采集"
    expect(fs.readFileSync(pngOut).equals(fs.readFileSync(a.pngPath))).toBe(true);
    const j = ev.judge({ dir: a.out });
    expect(j.problems).toEqual([]);
    expect(j.ok).toBe(true);
    expect(j.records.length).toBe(1);
    expect(j.records[0].stats.unique).toBe(120);
  });

  it('读数是 UTF-8 **无 BOM**（`.review/` 会被 G1 编码门禁扫）', () => {
    const a = archiveOne();
    const buf = fs.readFileSync(path.join(a.out, a.result.base + ev.EXT_JSON));
    expect(buf[0]).not.toBe(0xef);          // 不是 EF BB BF
    expect(buf.subarray(0, 1).toString('utf8')).toBe('{');
  });
});

/* ==================================================================
 * 四、★ 判别力证明：造假 / 改坏 ⇒ 必须红（8 种注入）
 * ------------------------------------------------------------------
 * 每一种注入都是"看起来有证据"的一种真实形状。问题码即判据的**判定档**。
 * ================================================================== */
describe('G-07 · 判别力证明：造假证据 ⇒ 判据必须红', () => {
  const codesOf = (j) => j.problems.map((p) => p.kind);

  it('注入 ①「只有截图、没有读数」⇒ no-json', () => {
    const a = archiveOne();
    fs.unlinkSync(path.join(a.out, a.result.base + ev.EXT_JSON));
    const j = ev.judge({ dir: a.out });
    expect(j.ok).toBe(false);
    expect(codesOf(j)).toContain('no-json');
  });

  it('注入 ②「只有读数、没有截图」⇒ no-png（读数描述的图不在 = 没有证据）', () => {
    const a = archiveOne();
    fs.unlinkSync(path.join(a.out, a.result.base + ev.EXT_PNG));
    const j = ev.judge({ dir: a.out });
    expect(j.ok).toBe(false);
    expect(codesOf(j)).toContain('no-png');
  });

  it('注入 ③「截图被换成另一张（字节变了）」⇒ sha-mismatch + bytes-mismatch', () => {
    const a = archiveOne();
    // 同尺寸、不同内容，**且字节数也不同**（尾部再补一段）⇒ 两个判据都该出声
    const other = Buffer.concat([makePng(40, 20, 9), Buffer.from('换成另一张图', 'utf8')]);
    expect(other.length).not.toBe(fs.readFileSync(a.pngPath).length);
    fs.writeFileSync(path.join(a.out, a.result.base + ev.EXT_PNG), other);
    const j = ev.judge({ dir: a.out });
    expect(j.ok).toBe(false);
    expect(codesOf(j)).toContain('sha-mismatch');
    expect(codesOf(j)).toContain('bytes-mismatch');
  });

  it('注入 ④「读数的 sha256 被改了」⇒ sha-mismatch', () => {
    const a = archiveOne();
    const p = path.join(a.out, a.result.base + ev.EXT_JSON);
    const j0 = JSON.parse(fs.readFileSync(p, 'utf8'));
    j0.sha256 = 'f'.repeat(64);
    fs.writeFileSync(p, JSON.stringify(j0, null, 2) + '\n', 'utf8');
    const j = ev.judge({ dir: a.out });
    expect(j.ok).toBe(false);
    expect(codesOf(j)).toContain('sha-mismatch');
  });

  it('注入 ⑤「读数的宽高被改了」⇒ size-mismatch（PNG IHDR 是独立来源）', () => {
    const a = archiveOne();
    const p = path.join(a.out, a.result.base + ev.EXT_JSON);
    const j0 = JSON.parse(fs.readFileSync(p, 'utf8'));
    j0.width = 41;
    fs.writeFileSync(p, JSON.stringify(j0, null, 2) + '\n', 'utf8');
    const j = ev.judge({ dir: a.out });
    expect(j.ok).toBe(false);
    expect(codesOf(j)).toContain('size-mismatch');
  });

  it('注入 ⑥「读数是空对象 `{}`」⇒ readings-incomplete（有文件 ≠ 有读数）', () => {
    const a = archiveOne();
    fs.writeFileSync(path.join(a.out, a.result.base + ev.EXT_JSON), '{}\n', 'utf8');
    const j = ev.judge({ dir: a.out });
    expect(j.ok).toBe(false);
    expect(codesOf(j)).toContain('readings-incomplete');
  });

  it('注入 ⑦「一对**空文件**」⇒ png-invalid + json-invalid + readings 不全（G8 第 ⑨ 条那种形状）', () => {
    const out = tmp();
    const base = ev.buildName({ at: new Date(2026, 9, 20, 15, 51, 49), tier: 'full', scope: 'all' });
    fs.writeFileSync(path.join(out, base + ev.EXT_PNG), Buffer.alloc(0));
    fs.writeFileSync(path.join(out, base + ev.EXT_JSON), '', 'utf8');
    const j = ev.judge({ dir: out });
    expect(j.ok).toBe(false);
    const c = codesOf(j);
    expect(c).toContain('png-invalid');
    expect(c).toContain('json-invalid');
    // 关键：**只凭"两个文件都在"永远不许绿**
    expect(j.records.length).toBe(1);
    expect(j.records[0].ok).toBe(false);
  });

  it('注入 ⑧「一条记录都没有」⇒ **跳过**（skipped），而不是通过', () => {
    const j = ev.judge({ dir: tmp() });
    expect(j.skipped).toBe(true);
    expect(j.ok).toBe(false);      // skipped 默认不是 ok
    expect(j.records.length).toBe(0);
  });

  it('对照组：同一份输入（未改坏）⇒ 判绿 —— 证明上面 8 条红都来自注入本身', () => {
    const a = archiveOne();
    expect(ev.judge({ dir: a.out }).ok).toBe(true);
  });
});

/* ==================================================================
 * 五、先判后写：对不上的一对**一个字节都不落盘**
 * ================================================================== */
describe('G-07 · 归档是"先判后写"', () => {
  it('取景记录与截图对不上 ⇒ 拒绝归档，且目标目录**零写入**', () => {
    const src = tmp();
    const out = tmp();
    const pair = writePair(src);
    // 把记录里的 sha 改坏（= 张冠李戴）
    const bad = JSON.parse(fs.readFileSync(pair.framePath, 'utf8'));
    bad.sha256 = 'a'.repeat(64);
    fs.writeFileSync(pair.framePath, JSON.stringify(bad, null, 2) + '\n', 'utf8');
    const r = ev.archiveFromFrame({ pngPath: pair.pngPath, framePath: pair.framePath, dir: out });
    expect(r.ok).toBe(false);
    expect(r.problems.join('；')).toMatch(/对不上/);
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it('截图不存在 ⇒ 拒绝归档并点名路径（采不到真值 = 不写）', () => {
    const src = tmp();
    const out = tmp();
    const pair = writePair(src);
    const r = ev.archiveFromFrame({ pngPath: path.join(src, '没有这个.png'), framePath: pair.framePath, dir: out });
    expect(r.ok).toBe(false);
    expect(fs.readdirSync(out)).toEqual([]);
  });
});

/* ==================================================================
 * 六、清理策略：保留最近 N 对，超了删最旧（成对删，绝不删出半对）
 * ================================================================== */
describe('G-07 · 清理策略：保留最近 KEEP 对、删最旧、成对删', () => {
  it('`prune` 只保留最近 3 对，删掉的**成对**（不制造半对）', () => {
    const out = tmp();
    for (let i = 0; i < 5; i++) {
      const src = tmp();
      const pair = writePair(src, { salt: i });
      const a = ev.archiveFromFrame({
        pngPath: pair.pngPath, framePath: pair.framePath, dir: out,
        at: new Date(2026, 9, 20, 10, 0, i)
      });
      expect(a.ok).toBe(true);
    }
    const before = fs.readdirSync(out).sort();
    expect(before.length).toBe(10);            // 5 对
    const r = ev.prune({ dir: out, keep: 3 });
    expect(r.kept).toBe(3);
    expect(r.removed.length).toBe(4);          // 最旧的 2 对 ×（png + json）
    const after = fs.readdirSync(out).sort();
    expect(after.length).toBe(6);
    // 剩下的都还能判绿 ⇒ 没有半对
    const j = ev.judge({ dir: out });
    expect(j.problems).toEqual([]);
    expect(j.records.length).toBe(3);
  });

  it('`prune` **不碰**不符合自家命名的文件（例如 record.js 的读图结论）', () => {
    const out = tmp();
    const keepFile = path.join(out, '20261020-1551-别的东西.json');
    fs.writeFileSync(keepFile, '{}\n', 'utf8');
    ev.archiveFromFrame({
      pngPath: writePair(tmp()).pngPath, framePath: writePair(tmp()).framePath, dir: out
    });
    const r = ev.prune({ dir: out, keep: 0 });
    expect(r.removed.length).toBe(2);          // 只删自家那一对
    expect(fs.existsSync(keepFile)).toBe(true);
  });

  it('`KEEP` 是清理策略的**唯一数字**（规则文本引用它，不另写一份）', () => {
    expect(Number.isInteger(ev.KEEP)).toBe(true);
    expect(ev.KEEP).toBeGreaterThan(0);
  });
});

/* ==================================================================
 * 七、真接缝：`roi.run()` 收尾把**判过的那一帧**归档（`main.js` 走的正是这条）
 * ------------------------------------------------------------------
 * 用假 NativeImage（但**带 `toPNG`**，与真 `NativeImage` 同形）驱动整条路径；
 * 落盘目录与源文件都指向临时目录 ⇒ 不碰真实证据库。
 * ================================================================== */
describe('G-07 · 真接缝：roi.run() 收尾归档同一帧', () => {
  const W = 40, H = 20;
  /** 假 NativeImage：`toBitmap` / `getSize` / **`toPNG`**（最后这个是"真帧"的结构标志） */
  function fakeNativeImage(salt) {
    const b = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        b[o] = (x * 6) % 256; b[o + 1] = (y * 12 + x) % 256; b[o + 2] = (x + y) % 256; b[o + 3] = 255;
      }
    }
    const png = makePng(W, H, salt || 0);
    return { toBitmap: () => b, getSize: () => ({ width: W, height: H }), toPNG: () => png, __png: png };
  }
  const RECTS = {
    toolbar: { x: 0, y: 0, width: W, height: 6 },
    'mindmap-container': { x: 0, y: 6, width: W, height: 14 }
  };
  const exec = async () => ({ rects: RECTS, dpr: 1 });

  function prepare(salt) {
    const src = tmp();
    const out = tmp();
    const img = fakeNativeImage(salt);
    const pair = writePair(src, { png: img.__png, width: W, height: H });
    return { src: src, out: out, img: img, pair: pair };
  }

  it('跑完 L2 ⇒ 证据落盘、且归档的就是 `img.toPNG()` 的**同一份字节**', async () => {
    const p = prepare(3);
    const r = await roi.run({
      exec: exec, img: p.img,
      evidence: { dir: p.out, png: p.pair.pngPath, frame: p.pair.framePath }
    });
    expect(r.length).toBe(roi.ROIS.length);            // 契约：条数恒等于清单长度
    const files = fs.readdirSync(p.out).sort();
    expect(files.length).toBe(2);
    const pngOut = path.join(p.out, files.filter((f) => f.slice(-4) === '.png')[0]);
    expect(fs.readFileSync(pngOut).equals(p.img.__png)).toBe(true);
    expect(ev.judge({ dir: p.out }).ok).toBe(true);
  });

  it('归档写不出去 ⇒ **抛**（"证据没落盘"绝不许静默放过）', async () => {
    const p = prepare(4);
    await expect(roi.run({
      exec: exec, img: p.img,
      evidence: { dir: p.out, png: path.join(p.src, '不存在.png'), frame: p.pair.framePath }
    })).rejects.toThrow(/L4 读图证据\*\*没落盘\*\*/);
  });

  it('`ctx.evidence === false` ⇒ 明确跳过归档（探针/单测用），条数仍等于清单长度', async () => {
    const p = prepare(5);
    const r = await roi.run({ exec: exec, img: p.img, evidence: false });
    expect(r.length).toBe(roi.ROIS.length);
    expect(fs.readdirSync(p.out)).toEqual([]);
  });

  it('假图没有 `toPNG`（= 单测里的桩）⇒ 不归档（**不会往证据库里写假记录**）', async () => {
    const out = tmp();
    const b = Buffer.alloc(W * H * 4, 200);
    const stub = { toBitmap: () => b, getSize: () => ({ width: W, height: H }) };
    // 即便显式给了落盘目录也不写 —— 判据是"它是不是真帧"（`toPNG`），不是"调用方有没有要多写"
    const r = await roi.run({ exec: exec, img: stub, evidence: { dir: out } });
    expect(r.length).toBe(roi.ROIS.length);
    expect(fs.readdirSync(out)).toEqual([]);
  });
});
