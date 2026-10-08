#!/usr/bin/env node
/* ============================================================
 * scripts/dsh-embedded-overrides.js —— 把"内置 DSH 的本地覆盖值"渲染进运行包配置
 * ------------------------------------------------------------
 * 为什么需要（2026-09-30 实证）：
 *   内置实例的 `profiles/web/cordis.patch.yml` 曾被**手工**改过（defaultPreset →
 *   workspace-write ✗）。手工态的代价有两个：① 下次重跑插件导入会被源侧同路径覆盖 ✗；
 *   ② 没人知道曾经改过 ✗。实测已经发生：那份手改现在在文件里**已经不见了**（又变回
 *   full-access-review）；而台账还记着它 ⇒ 手工态的"现状"和"记录"必然漂移 ✓。
 *   所以：**改动写在 overrides.json 里，由本脚本幂等渲染进 patch 文件** ✓。
 *
 * 协议（陈述式、只写差异）：
 *   <dsh-home>/.embedded-overrides.json
 *     { "permission.defaultPreset": "workspace-write",
 *       "agent-default-model.provider": "deepseek-official", ... }
 *   key = "<patch 条目的 id>.<config 里的键路径>"，value = 标量（字符串/数字/布尔）。
 *
 * 支持范围（白名单 —— 不做通用 YAML 序列化，工程零依赖 ✓）：
 *   permission.defaultPreset / agent-default-model.{provider,model,reasoningEffort}
 *   / permission-rules.rulesFile / auto-review.{maxReviewsPerTurn,fallbackPolicy}
 *   白名单外的键 ⇒ **报错退出**（不许猜 ✗）。
 *
 * 用法：
 *   node scripts/dsh-embedded-overrides.js render          # 渲染并写盘（先备份 ✓）
 *   node scripts/dsh-embedded-overrides.js render --dry-run # 只打印将改什么
 *   node scripts/dsh-embedded-overrides.js check           # 现网值 == overrides 期望值？
 *   --home <目录>  指定 dsh-home（默认 %APPDATA%\AI MindMap\dsh-home）
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const HOME = (() => {
  const i = process.argv.indexOf('--home');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const base = process.env.AI_MINDMAP_USERDATA || path.join(process.env.APPDATA || '', 'AI MindMap');
  return path.join(base, 'dsh-home');
})();
const PATCH = path.join(HOME, 'profiles', 'web', 'cordis.patch.yml');
const OVERRIDES = path.join(HOME, '.embedded-overrides.json');

/** 白名单：id → 允许改的键（以及它在 patch 里出现时"缩进层级"的定位方式） */
const ALLOWED = {
  'permission': ['defaultPreset'],
  'agent-default-model': ['provider', 'model', 'reasoningEffort'],
  'permission-rules': ['rulesFile'],
  'auto-review': ['maxReviewsPerTurn', 'fallbackPolicy']
};

function die(msg) { console.error('error: ' + msg); process.exit(1); }

/** 把 YAML 里的标量按需加引号（路径含反斜杠/冒号时必须引 ✓） */
function yamlScalar(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  return /^[A-Za-z0-9._\-\/]+$/.test(s) ? s : "'" + s.replace(/'/g, "''") + "'";
}

/** 读 overrides；不存在 ⇒ 空对象（= 没有任何本地覆盖 ✓，不算错误） */
function readOverrides() {
  if (!fs.existsSync(OVERRIDES)) return {};
  try { return JSON.parse(fs.readFileSync(OVERRIDES, 'utf8')); }
  catch (e) { die('overrides 不是合法 JSON：' + OVERRIDES + ' —— ' + e.message); }
}

/** 校验 overrides 的键都在白名单内（不在就报错，不猜 ✗） */
function validate(ov) {
  for (const k of Object.keys(ov)) {
    const dot = k.indexOf('.');
    if (dot < 0) die('overrides 的键必须是 "<id>.<键路径>" 形式，实际是：' + k);
    const id = k.slice(0, dot), key = k.slice(dot + 1);
    if (!ALLOWED[id]) die('不支持的 patch 条目 id：' + id + '（白名单：' + Object.keys(ALLOWED).join(', ') + '）');
    if (!ALLOWED[id].includes(key)) die('条目不支持改这个键：' + k + '（' + id + ' 只允许 ' + ALLOWED[id].join(', ') + '）');
  }
}

/** 找到 `- id: <id>` 那个条目的行区间 [start, end) */
function findEntry(lines, id) {
  const start = lines.findIndex((l) => new RegExp('^-\\s+id:\\s*' + id + '\\s*$').test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^-\s+/.test(lines[i])) { end = i; break; }   // 下一个顶级条目
  }
  return { start, end };
}

/** 在条目区间里替换 `key:` 的值 —— 支持"值换行续行"（本工程的 rulesFile 就是这种 ✓） */
function replaceKey(lines, span, key, value) {
  const re = new RegExp('^(\\s+' + key + ':\\s*)(.*)$');
  for (let i = span.start; i < span.end; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const oldRaw = m[2].trim();
    lines[i] = m[1] + yamlScalar(value);
    // 折行值：把紧跟其后的、更深缩进且不是 key: 的续行删掉（那是旧值的余下部分 ✓）
    let j = i + 1;
    while (j < span.end) {
      const l = lines[j];
      if (/^\s*$/.test(l) || /^\s*#/.test(l)) break;
      if (/^\s+[A-Za-z0-9_.-]+:/.test(l)) break;
      if (/^\s+/.test(l)) { lines.splice(j, 1); span.end--; continue; }
      break;
    }
    return { found: true, oldRaw };
  }
  return { found: false };
}

function render(dryRun) {
  const ov = readOverrides();
  validate(ov);
  if (!fs.existsSync(PATCH)) die('找不到 patch 文件：' + PATCH);
  const raw = fs.readFileSync(PATCH, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const changes = [];

  for (const k of Object.keys(ov)) {
    const dot = k.indexOf('.');
    const id = k.slice(0, dot), key = k.slice(dot + 1);
    const span = findEntry(lines, id);
    if (!span) die('patch 里没有条目 id=' + id + '（不存在的条目不许凭空新增 ✗）');
    const r = replaceKey(lines, span, key, ov[k]);
    if (!r.found) die('条目 ' + id + ' 里没有键 ' + key + '（不新增键 ✗；请先在 patch 里保留该键）');
    const next = yamlScalar(ov[k]);
    if (r.oldRaw !== next) changes.push('  ' + k + ': ' + r.oldRaw + ' → ' + next);
  }

  if (!changes.length) { console.log('无需改动 ✓（现网 == overrides，幂等 ✓）'); return; }
  console.log((dryRun ? '[dry-run] 将改动：' : '已改动：') + '\n' + changes.join('\n'));

  if (dryRun) return;
  const bak = PATCH + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(PATCH, bak);                        // 先备份（可回滚 ✓）
  fs.writeFileSync(PATCH, lines.join(eol), 'utf8');
  console.log('已写盘；备份：' + path.basename(bak));
}

/** check：现网文件里的值是否等于 overrides 期望（供升级后自检调用 ✓） */
function check() {
  const ov = readOverrides();
  validate(ov);
  if (!fs.existsSync(PATCH)) die('找不到 patch 文件：' + PATCH);
  const lines = fs.readFileSync(PATCH, 'utf8').split(/\r?\n/);
  let bad = 0;
  for (const k of Object.keys(ov)) {
    const dot = k.indexOf('.');
    const id = k.slice(0, dot), key = k.slice(dot + 1);
    const span = findEntry(lines, id);
    if (!span) { console.log('✗ ' + k + '：patch 里没有条目 ' + id + '（期望 ' + yamlScalar(ov[k]) + '）'); bad++; continue; }
    const m = lines.slice(span.start, span.end).map((l) => l.match(new RegExp('^\\s+' + key + ':\\s*(.*)$'))).find(Boolean);
    const got = m ? m[1].trim() : '(缺)';
    const want = yamlScalar(ov[k]);
    if (got === want) console.log('✓ ' + k + ' = ' + got);
    else { console.log('✗ ' + k + '：期望 ' + want + '，实际 ' + got); bad++; }
  }
  if (!Object.keys(ov).length) console.log('（overrides 为空 —— 没有本地覆盖要核对 ✓）');
  process.exit(bad ? 1 : 0);
}

const cmd = process.argv[2];
if (cmd === 'render') render(process.argv.includes('--dry-run'));
else if (cmd === 'check') check();
else { console.log('用法：node scripts/dsh-embedded-overrides.js <render [--dry-run]|check> [--home <dsh-home>]'); process.exit(1); }
