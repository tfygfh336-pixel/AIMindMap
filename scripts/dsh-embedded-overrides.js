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
 * ⚠️ **本脚本是 profile patch 文件的唯一写者**。新增"要渲染进 patch 的东西"时，
 *    请扩这里，**不要**再开第二个脚本去写同一个文件（两个写者 = 谁最后写谁赢 ✗）。
 *
 * ── 两类被渲染的东西 ──────────────────────────────────────────────
 * ① 标量覆盖（改**已存在**条目的**已存在**键）：
 *      { "permission.defaultPreset": "workspace-write",
 *        "agent-default-model.provider": "deepseek-official", ... }
 *    key = "<patch 条目的 id>.<config 里的键路径>"，value = 标量（字符串/数字/布尔）。
 *
 * ② agent preset 声明（**插入**一条新条目，2026-10-08 新增）：
 *      { "$presets": { "aimindmap": { "cloneFrom": "standard", "makeDefault": true } } }
 *    `cloneFrom` = 从运行包里哪个内置 preset 复制清单（`standard` / `ptc` / `minimal` / `cordis`）；
 *    `makeDefault: true` 额外覆盖注册表那一行（`agent-preset-registry: {default: <id>}`）——
 *    注意**用户选择优先**：使用者在界面里选过模式（volatile 的 `selectedDefault`）时部署默认不生效。
 *    **为什么是"生成"而不是把清单抄进本仓库**：一条 preset 的 `plugins` 是"这个模式的
 *    agent 能用的全部东西"（人设 / 工具 / 技能 / plan-mode / 压缩 / 委派），它是**运行包的
 *    事实**，随内置 DSH 升级会变。手抄一份 = 又一份会漂移的副本（台账 R8 那类）。所以本
 *    脚本在渲染时**从运行包自带的 `<runtime>/app/node_modules/@deepseek-ai/dsh-web-app/presets/
 *    <cloneFrom>.patch.yml` 读出清单原文**，只替换其中的 persona 文本 ⇒ 单一真源 ✓。
 *
 * 支持范围（白名单 —— 不做通用 YAML 序列化，工程**零必需运行时依赖** ✓；
 * 唯一例外是 PDF 解析用的 `pdfjs-dist`）：
 *   permission.defaultPreset / agent-default-model.{provider,model,reasoningEffort}
 *   / permission-rules.rulesFile / auto-review.{maxReviewsPerTurn,fallbackPolicy}
 *   / $presets.<id>.{cloneFrom,order}（`cloneFrom` 必须是运行包里真实存在的 preset 名）
 *   白名单外的键 ⇒ **报错退出**（不许猜 ✗）。
 *
 * 用法：
 *   node scripts/dsh-embedded-overrides.js render            # 渲染并写盘（先备份 ✓）
 *   node scripts/dsh-embedded-overrides.js render --dry-run  # 只打印将改什么
 *   node scripts/dsh-embedded-overrides.js check             # 现网 == overrides 期望？
 *   --home <目录>     指定 dsh-home（默认 %APPDATA%\AI MindMap\dsh-home）
 *   --runtime <目录>  指定内置 DSH 运行包（默认 <工程>/vendor/dsh；打包后传 resources/dsh）
 *
 * 测试用：`tests/dsh-embedded-overrides.test.js`（纯函数 + 临时 home 的端到端，不碰真实实例）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

/** 命令行取值（`--k v`） */
function argOf(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const HOME = (() => {
  const given = argOf('home');
  if (given) return given;
  const base = process.env.AI_MINDMAP_USERDATA || path.join(process.env.APPDATA || '', 'AI MindMap');
  return path.join(base, 'dsh-home');
})();
const PATCH = path.join(HOME, 'profiles', 'web', 'cordis.patch.yml');
const OVERRIDES = path.join(HOME, '.embedded-overrides.json');
/** 运行包：dev 用 <工程>/vendor/dsh；打包后由调用方传 --runtime <resources/dsh> */
const RUNTIME = argOf('runtime') || path.join(REPO, 'vendor', 'dsh');
const PRESETS_DIR = path.join(RUNTIME, 'app', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets');

/** 白名单：id → 允许改的键 */
const ALLOWED = {
  'permission': ['defaultPreset'],
  'agent-default-model': ['provider', 'model', 'reasoningEffort'],
  'permission-rules': ['rulesFile'],
  'auto-review': ['maxReviewsPerTurn', 'fallbackPolicy']
};

/** preset 声明的白名单：只允许这几个 id，且人设文本在这里（唯一真源） */
const PRESETS = {
  aimindmap: {
    label: 'aimindmap 模式',
    description: 'AI MindMap 笔记工程的作业模式：以工程自带 CLI/MCP 为准，验证守纪律，结论必须有据。',
    order: 0,
    persona: [
      '你是「AI MindMap」（一个由人机协作长期迭代的笔记工程）内置的作业助手，当前工作在 aimindmap 模式下。',
      '',
      '工作准则（按优先级从高到低）：',
      '1. 先读指针技能 `ai-mind-map`（在 skills 里）：本工程的命令、规矩、验证链都写在那里 —— 它是单一真源，别凭记忆猜命令名或参数。',
      '2. 改笔记数据一律走工程自带的 CLI / MCP 命令（写盘有版本闸门与校验）；**不要**直接编辑 `projects/` 下的 JSON。',
      '3. 跑验证守纪律：验证会写盘 ⇒ 用工程自带的重定向（冒烟跑在临时副本上），**绝不拿真实笔记当试验场**；只动了一条断言就用 `SMOKE_ONLY=<域前缀> npm run smoke` 单跑，别每次都跑全链。',
      '4. 结论必须有据：能跑的命令就跑；不能跑就明说「未验证」，不要把推断写成事实。',
      '5. 汇报用中文：先给结论与证据，再给细节；改动小步、可回退，并写清「改了什么 / 怎么验的 / 还缺什么」。'
    ].join('\n')
  }
};

/** 生成物区块的横幅（幂等替换靠它；改动这两行会让旧块无法被识别 ✗） */
const BANNER_BEGIN = '# ── [生成物·agent preset] 由 scripts/dsh-embedded-overrides.js 渲染，请勿手改 ──';
const BANNER_END = '# ── [/生成物·agent preset] ──';

function die(msg) { console.error('error: ' + msg); process.exit(1); }

/** 把 YAML 里的标量按需加引号（路径含反斜杠/冒号时必须引 ✓） */
function yamlScalar(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  return /^[A-Za-z0-9._\-\/]+$/.test(s) ? s : "'" + s.replace(/'/g, "''") + "'";
}

function readOverrides() {
  if (!fs.existsSync(OVERRIDES)) return {};
  try { return JSON.parse(fs.readFileSync(OVERRIDES, 'utf8')); }
  catch (e) { die('overrides 不是合法 JSON：' + OVERRIDES + ' —— ' + e.message); }
}

/** overrides 里的标量键（排除 $presets 这种保留键） */
function scalarKeys(ov) {
  return Object.keys(ov).filter((k) => k.charAt(0) !== '$');
}

function validate(ov) {
  for (const k of scalarKeys(ov)) {
    const dot = k.indexOf('.');
    if (dot < 0) die('overrides 的键必须是 "<id>.<键路径>" 形式，实际是：' + k);
    const id = k.slice(0, dot), key = k.slice(dot + 1);
    if (!ALLOWED[id]) die('不支持的 patch 条目 id：' + id + '（白名单：' + Object.keys(ALLOWED).join(', ') + '）');
    if (!ALLOWED[id].includes(key)) die('条目不支持改这个键：' + k + '（' + id + ' 只允许 ' + ALLOWED[id].join(', ') + '）');
  }
  const presets = ov.$presets;
  if (presets === undefined) return;
  if (!presets || typeof presets !== 'object' || Array.isArray(presets)) die('$presets 必须是对象：{ "<id>": { cloneFrom, order } }');
  for (const id of Object.keys(presets)) {
    if (!PRESETS[id]) die('$presets 里不认识的 preset id：' + id + '（白名单：' + Object.keys(PRESETS).join(', ') + '；要加新模式请先在脚本的 PRESETS 里写好人设）');
    const spec = presets[id] || {};
    if (!spec.cloneFrom) die('$presets.' + id + ' 缺 cloneFrom（要从哪个内置 preset 复制清单，如 standard）');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(spec.cloneFrom)) die('$presets.' + id + '.cloneFrom 不是合法 preset 名：' + spec.cloneFrom);
    if (spec.order !== undefined && typeof spec.order !== 'number') die('$presets.' + id + '.order 必须是数字');
    if (spec.makeDefault !== undefined && typeof spec.makeDefault !== 'boolean') die('$presets.' + id + '.makeDefault 必须是布尔');
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

/* ---------------- ② preset 声明的生成 ----------------
 * 从运行包自带的 `<cloneFrom>.patch.yml` 里把 `config.plugins` 的**原文**取出来，
 * 只把 persona 的 prefix 换成我们的人设 ⇒ 不手抄、不漂移 ✓。
 */

/** 读运行包里某个内置 preset 的行（找不到 ⇒ 响亮失败，绝不静默用空清单 ✗） */
function readBuiltinPresetLines(cloneFrom) {
  const f = path.join(PRESETS_DIR, cloneFrom + '.patch.yml');
  if (!fs.existsSync(f)) {
    die('运行包里没有内置 preset「' + cloneFrom + '」：' + f
      + '\n  （--runtime 指对了么？或该 preset 名不在运行包内。可用：' + listBuiltinPresets().join(', ') + '）');
  }
  return fs.readFileSync(f, 'utf8').split(/\r?\n/);
}

function listBuiltinPresets() {
  try {
    return fs.readdirSync(PRESETS_DIR).filter((f) => /\.patch\.yml$/.test(f)).map((f) => f.replace(/\.patch\.yml$/, ''));
  } catch (e) { return []; }
}

/** 从内置 preset 文件里切出 `config.plugins:` 那一段（含 items，保持原始缩进 ✓） */
function extractPluginsBlock(lines, cloneFrom) {
  const at = lines.findIndex((l) => /^\s+plugins:\s*$/.test(l));
  if (at < 0) die('内置 preset「' + cloneFrom + '」里没找到 `plugins:` 段（运行包结构变了？请看 ' + PRESETS_DIR + '）');
  const indent = lines[at].match(/^\s*/)[0].length;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*$/.test(l)) continue;
    if (/^\s*#/.test(l) && l.match(/^\s*/)[0].length <= indent) { end = i; break; }
    if (l.match(/^\s*/)[0].length <= indent) { end = i; break; }
  }
  // 去掉尾部空行（它们属于段间的排版，不属于块本体）
  while (end > at + 1 && /^\s*$/.test(lines[end - 1])) end--;
  return { start: at, end, indent };
}

/** 把块里的 persona prefix 换成人设文本（块标量写法；重复渲染同一来源 ⇒ 天然幂等 ✓） */
function replacePersonaPrefix(block, persona) {
  const at = block.findIndex((l) => /^\s*-\s+id:\s*persona\s*$/.test(l));
  if (at < 0) return { ok: false, why: '清单里没有 persona 行（该 preset 的人设可能由别处提供）' };
  const keyAt = block.findIndex((l, i) => i > at && /^\s+prefix:\s*/.test(l));
  if (keyAt < 0) return { ok: false, why: 'persona 行里没有 prefix: 键' };
  const keyIndent = block[keyAt].match(/^\s*/)[0];
  const out = block.slice(0, keyAt).concat(
    // `|-`（strip 收尾换行）：让"写进去的字符串"与"读回来的字符串"逐字相等，
    // 单测因此可以要求严格相等（用 `|` 会多一个尾随 \n，正是它抓出来的 ✓）
    [keyIndent + 'prefix: |-'],
    persona.split('\n').map((l) => (l ? keyIndent + '  ' + l : '')),
    block.slice(keyAt + 1)
  );
  return { ok: true, lines: out };
}

/** 生成"一条 preset 声明"的完整块（含横幅）；返回 string[] */
function buildPresetBlock(id, spec) {
  const meta = PRESETS[id];
  const order = spec.order === undefined ? meta.order : spec.order;
  const src = readBuiltinPresetLines(spec.cloneFrom);
  const span = extractPluginsBlock(src, spec.cloneFrom);
  const block = src.slice(span.start, span.end);
  const swapped = replacePersonaPrefix(block, meta.persona);
  if (!swapped.ok) die('无法把人设写进 preset「' + id + '」：' + swapped.why + '；换 cloneFrom 或改脚本的人设注入点');
  const out = [BANNER_BEGIN,
    '# 来源：' + path.join('presets', spec.cloneFrom + '.patch.yml').replace(/\\/g, '/') + '（运行包自带）＋ 脚本内人设文本',
    '# 手改无效：下一次 render 会整块覆盖。要改就先改 .embedded-overrides.json 或脚本，再 render。',
    '- insert:',
    '    - id: preset-' + id,
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: ' + id,
    '        name: ' + yamlScalar(meta.label),
    '        description: ' + yamlScalar(meta.description),
    '        order: ' + order
  ];
  for (const l of swapped.lines) out.push(l || '');
  if (spec.makeDefault) {
    // 设成默认模式：注册表那一行**不在** profile patch 里（它由 `dsh-web-app` bundle 定义）
    // ⇒ 用"**按 id 覆盖**"这种 patch 条目（与 patch 里 permission / approval 那几行同一形态 ✓）。
    // ⚠️ 按 id 覆盖会**整份替换该行的 config** —— 该行的 config 只有 `default` 一个键
    //   （见 `dsh-agent-preset-registry` README 的字段表），所以这里是完整的 ✓。
    // 注意用户选择优先：若使用者在界面里选过模式（`selectedDefault`），部署默认不生效。
    out.push('# 默认模式：覆盖注册表那一行（按 id 覆盖 = 整份 config 替换；该行只有 default 一个键）',
      '- id: agent-preset-registry',
      '  config:',
      '    default: ' + id);
  }
  out.push(BANNER_END);
  return out;
}

/** 把生成块替换进 patch 行数组（幂等：先删旧的同类块，再按 id 顺序追加到末尾） */
function applyPresetBlocks(lines, ov) {
  const presets = ov.$presets || {};
  const ids = Object.keys(presets);
  // 删旧块：从 BEGIN 行到 END 行（含），若只有 BEGIN 没有 END（半截）⇒ 响亮点出，不猜 ✗
  const kept = [];
  let removed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== BANNER_BEGIN) { kept.push(lines[i]); continue; }
    let j = i;
    while (j < lines.length && lines[j].trim() !== BANNER_END) j++;
    if (j >= lines.length) die('patch 里有生成的 BEGIN 横幅但没有 END（文件被手工破坏过？）：' + PATCH);
    i = j;
    removed++;
  }
  if (!ids.length) return { lines: kept, changed: removed > 0, removed };
  // 统一放在末尾：一个区域、一眼能看全 ✓
  while (kept.length && /^\s*$/.test(kept[kept.length - 1])) kept.pop();
  const block = [];
  for (const id of ids) { if (block.length) block.push(''); block.push(...buildPresetBlock(id, presets[id])); }
  return { lines: kept.concat('', ...block, ''), changed: true, removed };
}

function render(dryRun) {
  const ov = readOverrides();
  validate(ov);
  if (!fs.existsSync(PATCH)) die('找不到 patch 文件：' + PATCH);
  const raw = fs.readFileSync(PATCH, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const before = raw.split(/\r?\n/);
  const lines = before.slice();
  const changes = [];

  for (const k of scalarKeys(ov)) {
    const dot = k.indexOf('.');
    const id = k.slice(0, dot), key = k.slice(dot + 1);
    const span = findEntry(lines, id);
    if (!span) die('patch 里没有条目 id=' + id + '（不存在的条目不许凭空新增 ✗）');
    const r = replaceKey(lines, span, key, ov[k]);
    if (!r.found) die('条目 ' + id + ' 里没有键 ' + key + '（不新增键 ✗；请先在 patch 里保留该键）');
    const next = yamlScalar(ov[k]);
    if (r.oldRaw !== next) changes.push('  ' + k + ': ' + r.oldRaw + ' → ' + next);
  }

  const preset = applyPresetBlocks(lines, ov);
  const after = preset.lines;
  const presetIds = Object.keys(ov.$presets || {});
  const blockChanged = presetIds.length ? after.join('\n') !== before.join('\n') : preset.changed;

  if (!changes.length && !blockChanged) { console.log('无需改动 ✓（现网 == overrides，幂等 ✓）'); return; }
  if (changes.length) console.log((dryRun ? '[dry-run] 将改动：' : '已改动：') + '\n' + changes.join('\n'));
  if (presetIds.length) {
    console.log('  $presets: ' + presetIds.join(', ')
      + ' ⇒ ' + (preset.removed ? '替换已有生成块（' + preset.removed + ' 个）' : '新增生成块')
      + '；清单来源 ' + presetIds.map((i) => ov.$presets[i].cloneFrom).join(', ') + '（运行包自带）');
  }

  if (dryRun) return;
  const bak = PATCH + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(PATCH, bak);                        // 先备份（可回滚 ✓）
  fs.writeFileSync(PATCH, after.join(eol), 'utf8');
  console.log('已写盘；备份：' + path.basename(bak));
}

/** check：现网文件里的值是否等于 overrides 期望（供升级后自检调用 ✓） */
function check() {
  const ov = readOverrides();
  validate(ov);
  if (!fs.existsSync(PATCH)) die('找不到 patch 文件：' + PATCH);
  const lines = fs.readFileSync(PATCH, 'utf8').split(/\r?\n/);
  let bad = 0;
  for (const k of scalarKeys(ov)) {
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
  // 生成块：与"现在重新生成"逐行比对（逐字相等才算 ✓ —— 半截/被手改都会被抓到）
  const presets = ov.$presets || {};
  for (const id of Object.keys(presets)) {
    const want = buildPresetBlock(id, presets[id]);
    const wantBlock = [BANNER_BEGIN].concat(want.slice(1, -1), [BANNER_END]);
    const at = lines.findIndex((l) => l.trim() === BANNER_BEGIN);
    if (at < 0) { console.log('✗ $presets.' + id + '：patch 里没有生成块（没 render 过？）'); bad++; continue; }
    let end = at;
    while (end < lines.length && lines[end].trim() !== BANNER_END) end++;
    const gotBlock = lines.slice(at, end + 1);
    const expecting = wantBlock.filter((l) => !/^#\s*来源/.test(l) && !/^#\s*手改无效/.test(l));
    const gotFiltered = gotBlock.filter((l) => !/^#\s*来源/.test(l) && !/^#\s*手改无效/.test(l));
    if (gotFiltered.join('\n') === expecting.join('\n')) {
      console.log('✓ $presets.' + id + '：生成块与当前内置 preset 一致（' + presets[id].cloneFrom + ' 的清单 + 本脚本人设）');
    } else {
      console.log('✗ $presets.' + id + '：生成块与"现在重新生成"的结果不一致（内置 preset 升级了？或块被改过 ⇒ 重跑 render）');
      bad++;
    }
  }
  if (!Object.keys(ov).length) console.log('（overrides 为空 —— 没有本地覆盖要核对 ✓）');
  process.exit(bad ? 1 : 0);
}

/* ⚠️ CLI 分支必须有 require.main 守卫：否则 `require()` 它做单测时会**当场执行 CLI 并 exit** ✗
 *（本工程既有规矩：门禁要把纯函数暴露出来做单测。实测踩过：没守卫时 require 打印用法并退出。） */
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'render') render(process.argv.includes('--dry-run'));
  else if (cmd === 'check') check();
  else {
    console.log('用法：node scripts/dsh-embedded-overrides.js <render [--dry-run]|check> [--home <dsh-home>] [--runtime <运行包>]');
    process.exit(1);
  }
}

module.exports = { yamlScalar, validate, findEntry, replaceKey, extractPluginsBlock, replacePersonaPrefix, buildPresetBlock, applyPresetBlocks, PRESETS, BANNER_BEGIN, BANNER_END, PRESETS_DIR, HOME, PATCH };
