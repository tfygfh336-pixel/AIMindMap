#!/usr/bin/env node
/* ============================================================
 * scripts/vision/record.js — 读图留痕（阶段 4）：把「AI 看过这张图」写成可追溯的证据
 * ------------------------------------------------------------
 * **存在的唯一理由**：L1/L2/L3 都是**机器**判定，而有一类异常机器判不了 ——
 * 语义级的（"这个按钮怎么没了""这块文案是不是串行了"）。本工程的判定阶梯把它记为 **L4**，
 * 并明说它"**无法自动判定 → 靠纪律 + 人复核**"（`docs/ARCHITECTURE.md` §4b）。所以本模块的定位是
 * **产出证据**，而**不是加一道门禁** —— 给一个自称不可自动判定的层级加门禁是自相矛盾的。
 *
 * ## 两条关键设计（都是为了让它不退化成一个仪式）
 *
 * 1. **哈希由本脚本从 `smoke-frame.json` 机械取，绝不由人手打。**
 *    否则"结论与当时那张 PNG 绑定"就成了空话：图换了、结论还是旧的，没人能发现。
 *    脚本还**验证当前 `smoke-shot.png` 的 sha256 与记录里的一致**，不一致就**拒绝写**并说明
 *    —— 这防的正是"张冠李戴"。
 *
 * 2. **记录里不写任何需要手打的数字。** 断言计数（冒烟 / 视觉）从 `smoke-frame.json` 读，
 *    分辨率也从那里读。手打的数字会腐坏（早期样例 JSON 里手写了 `"smokeCount": 112`
 *    与 `"resolution": "1424x835"` 就是这类问题）。
 *
 * ## 与工程既有约定的关系（这里曾经自相矛盾，已裁决）
 * 本工程早期的规格稿要求"`.review/vision/` **需先在 `ARCHITECTURE.md` §5 登记**"，
 * 而 `ARCHITECTURE.md` 明确"**工作产物（含读图结论）不进 §5 口径**" ⇒ **两者互斥**。
 * **裁决：按工作产物处理** —— 落 `.review/vision/`（G8 豁免、G6 豁免），**不登记 §5**（该裁决已记入 `docs/ARCHITECTURE.md` §4b ADR）。
 * ⚠️ 但 **G1（编码门禁）会扫 `.review/`** ⇒ 记录必须 **UTF-8 无 BOM**。
 * 本脚本用 `fs.writeFileSync(..., 'utf8')` 写，**不要**用 PowerShell 的 `Set-Content`（会带 BOM）。
 *
 * 用法：
 *   node scripts/vision/record.js --topic "详情框改版" --verdict ok \
 *        --check "工具栏=ok" --check "导图=ok" --check "详情框=missing:本次未打开" \
 *        [--frame smoke-frame.json] [--png smoke-shot.png] [--out-dir .review/vision] [--note "…"]
 * 退出码：0 = 已写入；1 = 拒绝写入（缺取证、哈希不符、参数非法）—— **拒绝必须响亮**。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const VERDICTS = ['ok', 'unexpected', 'missing'];

/** 文件名安全化：只留中英文数字与连字符，其余折成连字符。 */
function slug(s) {
  return String(s || '').trim().replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'unnamed';
}

/** 解析 `--check "区域=verdict[:说明]"`。 */
function parseCheck(raw) {
  const s = String(raw || '');
  const eq = s.indexOf('=');
  if (eq <= 0) return { error: '格式应为 「区域=ok|unexpected|missing[:说明]」：' + s };
  const key = s.slice(0, eq).trim();
  const rest = s.slice(eq + 1);
  const colon = rest.indexOf(':');
  const verdict = (colon < 0 ? rest : rest.slice(0, colon)).trim();
  const why = colon < 0 ? '' : rest.slice(colon + 1).trim();
  if (!key) return { error: '区域名为空：' + s };
  if (VERDICTS.indexOf(verdict) < 0) return { error: '未支持的判定「' + verdict + '」（只允许 ' + VERDICTS.join(' / ') + '）：' + s };
  // missing 必须说清是"不适用"还是"不见了" —— 这是本工程判定阶梯 L4 的硬要求（阶梯见 `docs/ARCHITECTURE.md` §4b）
  if (verdict === 'missing' && !why) return { error: 'missing 必须注明是不适用还是不见了：' + s };
  return { key, verdict, why };
}

/**
 * 组装记录（**纯函数**，便于单测）。
 * @param {{frame:object, topic:string, verdict:string, checks:Array, note:string, pngSha256:string, now:Date}} input
 */
function buildRecord(input) {
  const f = input.frame || {};
  const problems = [];
  if (!f.sha256) problems.push('取景记录里没有 sha256（smoke-frame.json 不完整？）');
  if (!f.width || !f.height) problems.push('取景记录里没有分辨率');
  if (!input.topic) problems.push('缺少 --topic（迭代主题）');
  if (VERDICTS.indexOf(input.verdict) < 0) problems.push('--verdict 只允许 ' + VERDICTS.join(' / '));
  if (!input.checks || !input.checks.length) problems.push('至少要有一条 --check（读图逐项结论）');
  if (f.sha256 && input.pngSha256 && f.sha256 !== input.pngSha256) {
    problems.push('哈希不符：取景记录是 ' + f.sha256.slice(0, 16) + '，而当前 smoke-shot.png 是 '
      + input.pngSha256.slice(0, 16) + ' ⇒ 记录会绑到一张已经过期的图上，拒绝写入');
  }
  if (problems.length) return { ok: false, problems };

  const at = input.now || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = '' + at.getFullYear() + pad(at.getMonth() + 1) + pad(at.getDate())
    + '-' + pad(at.getHours()) + pad(at.getMinutes());
  const checklist = {};
  for (const c of input.checks) checklist[c.key] = c.why ? { verdict: c.verdict, why: c.why } : c.verdict;

  return {
    ok: true,
    name: stamp + '-' + slug(input.topic) + '.json',
    record: {
      _comment: '静默验证闭环的读图留痕（L4）。它是**本次迭代的证据**，不是跨迭代比对键：'
        + '哈希绑定的是本次 smoke-shot.png，图一换本记录即过期。不进门禁（L4 无法自动判定）。',
      iteration: input.topic,
      at: at.toISOString(),
      png: input.pngName || 'smoke-shot.png',
      sha256: f.sha256,
      resolution: f.width + 'x' + f.height,
      smokeAssertions: f.smokeAssertions === undefined ? null : f.smokeAssertions,
      visionAssertions: f.visionAssertions === undefined ? null : f.visionAssertions,
      verdict: input.verdict,
      checklist,
      note: input.note || ''
    }
  };
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function main() {
  const argv = process.argv.slice(2);
  const a = { checks: [], note: '', frame: 'smoke-frame.json', png: 'smoke-shot.png', outDir: path.join('.review', 'vision') };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--topic') a.topic = argv[++i];
    else if (k === '--verdict') a.verdict = argv[++i];
    else if (k === '--check') a.checks.push(argv[++i]);
    else if (k === '--note') a.note = argv[++i];
    else if (k === '--frame') a.frame = argv[++i];
    else if (k === '--png') a.png = argv[++i];
    else if (k === '--out-dir') a.outDir = argv[++i];
    else { console.error('error: 未知参数 ' + k); process.exit(1); }
  }
  const framePath = path.resolve(ROOT, a.frame);
  if (!fs.existsSync(framePath)) {
    console.error('error: 找不到取景记录 ' + framePath
      + '\n（它由 `npm run smoke` 产出。没有它就无法把结论绑到那张图上 —— 拒绝写入。）');
    process.exit(1);
  }
  const parsed = [];
  for (const raw of a.checks) {
    const c = parseCheck(raw);
    if (c.error) { console.error('error: ' + c.error); process.exit(1); }
    parsed.push(c);
  }
  const pngPath = path.resolve(ROOT, a.png);
  const pngSha = fs.existsSync(pngPath) ? sha256File(pngPath) : '';
  const built = buildRecord({
    frame: JSON.parse(fs.readFileSync(framePath, 'utf8')),
    topic: a.topic, verdict: a.verdict, checks: parsed, note: a.note,
    pngSha256: pngSha, pngName: a.png
  });
  if (!built.ok) {
    console.error('error: 拒绝写入读图记录：');
    for (const p of built.problems) console.error('  · ' + p);
    process.exit(1);
  }
  const outDir = path.resolve(ROOT, a.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, built.name);
  // ⚠️ utf8 无 BOM：`.review/` **会被 G1（编码门禁）扫**，带 BOM 会让 verify 第 1 步就红
  fs.writeFileSync(outPath, JSON.stringify(built.record, null, 2) + '\n', 'utf8');
  console.log('已写入读图记录: ' + path.relative(ROOT, outPath));
  console.log('  绑定 sha256: ' + built.record.sha256.slice(0, 16) + '（' + built.record.resolution + '）');
  console.log('  判定: ' + built.record.verdict + '  逐项: ' + Object.keys(built.record.checklist).join(', '));
}

if (require.main === module) main();

module.exports = { slug, parseCheck, buildRecord, VERDICTS };
