#!/usr/bin/env node
/* ============================================================
 * scripts/dsh-fixture-freshness.js —— 「装配面夹具」与运行包的一致性门禁
 * ------------------------------------------------------------
 * **存在理由（真实事故）**：`tests/fixtures/dsh-composed-tree-web.txt` 一直自称是
 * 「内置实例 web 装配面」的快照，但它**落后运行包两代**：152 行 vs 287 行、缺 49 个 id
 * （含 `ui-sidebar-browser` / `ui-sidebar-terminal` 这两个"侧栏入口"）、还有 3 个反向残留。
 * 照它数入口 ⇒ **结论必错**（`e3102ac` 那批就差点错在这）。
 *
 * 本脚本同时是**唯一的写者**（`--write`）与**唯一的校验者**（无参数）：
 *   · 快照内容 = 出处头（本脚本生成）+ 运行包 `--dump-config` 的原样正文；
 *   · 校验 = 重跑同一配方，与文件正文逐字比对 ⇒ 「改了运行包没改夹具」必红。
 * 写者/校验者同源，是为了让"怎么生成的"与"怎么判的"不可能漂成两句话。
 *
 * ⚠️ **它在什么环境才成立**（写死在这里，免得被当成到处都跑的门禁）：
 *   `vendor/dsh/` 被 `.gitignore` 第 35 行忽略、**不在版本库**（`git ls-files vendor` = 0）。
 *   ⇒ 有运行包的机器（本机 dev / 打包机）上，它真的比对；**没有运行包时它不"跳过"**，
 *   而是 **exit 3 + 明确报文**（`找不到 DSH 运行包`）—— 调用方（`scripts/cli-integration.js`）
 *   两种情形都断言：有 vendor 断言"一致"，无 vendor 断言"响亮报错"。**绝不允许静默放过。**
 *
 * 退出码：0 = 一致；1 = 不一致 / 夹具损坏 / 写失败；3 = 找不到运行包（响亮契约）。
 *
 * 用法：
 *   node scripts/dsh-fixture-freshness.js              # 校验（EXIT 0/1/3）
 *   node scripts/dsh-fixture-freshness.js --write      # 重新生成夹具（唯一合法手改替代）
 *   node scripts/dsh-fixture-freshness.js --json       # 机器可读读数
 *   node scripts/dsh-fixture-freshness.js --vendor <dir> --fixture <path>   # 判别力证明用
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_REL = path.join('tests', 'fixtures', 'dsh-composed-tree-web.txt');
/** 夹具正文的起点标记 —— 与 `scripts/dsh-assembly-probe.js` 的层标签同一条正则 */
const BODY_START_RE = /^#\s*==/;
const ROW_RE = /^(\s*)- id:\s*(\S.*?)\s*$/;
const DISABLED_RE = /^(\s*)disabled:\s*(.+?)\s*$/;
const NO_VENDOR_MSG = '找不到 DSH 运行包';

/** 只在 `id` 行自己那一级（缩进 +2）上的 `disabled:` 才算这个包的 ——
 *  合成树里 `preset-*.config.plugins[]` 的嵌套行也有 `disabled:`，按"任意一条"读会张冠李戴。 */
function readRows(text) {
  const rows = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = ROW_RE.exec(line);
    if (m) {
      if (cur) rows.push(cur);
      cur = { id: m[2].replace(/^['"]|['"]$/g, ''), indent: m[1].length, disabled: null };
      continue;
    }
    if (!cur) continue;
    const d = DISABLED_RE.exec(line);
    if (d && d[1].length === cur.indent + 2 && cur.disabled === null) cur.disabled = d[2];
  }
  if (cur) rows.push(cur);
  return rows;
}

/** 夹具 → { header, body }。正文起点 = 第一条 `# ==`（层标签），之前的一切都是出处头。 */
function splitFixture(text) {
  const lines = String(text || '').split(/\r?\n/);
  const at = lines.findIndex((l) => BODY_START_RE.test(l));
  if (at < 0) return { header: '', body: lines.join('\n') };
  return { header: lines.slice(0, at).join('\n'), body: lines.slice(at).join('\n') };
}

const normalize = (t) => {
  const s = String(t || '').replace(/\r\n/g, '\n');
  return s.endsWith('\n') ? s : s + '\n';
};

/** 出处头（**确定性**：不含时间戳；行数由正文现算，手改头会立刻对不上） */
function renderHeader(version, body, fixtureRel) {
  const rows = readRows(body);
  const withDisabled = rows.filter((r) => r.disabled !== null);
  const expr = withDisabled.filter((r) => !/^true$/.test(r.disabled));
  return [
    '# ------------------------------------------------------------------',
    '# DSH 合成装配树**冻结样本** —— ⚠️ 这**不是**「当前装配面」',
    '# ------------------------------------------------------------------',
    '# 要「当前装配面」          : npm run dsh:probe      （需 vendor/dsh；现跑 --dump-config）',
    '# 要「重新生成本文件」      : node scripts/dsh-fixture-freshness.js --write',
    '# 要「校验与运行包是否一致」: node scripts/dsh-fixture-freshness.js',
    '#',
    '# 运行包 : @deepseek-ai/dsh ' + version + '（<工程>/vendor/dsh —— 被 .gitignore 忽略、**不在版本库**）',
    '# 配方   : 隔离 DSH_HOME + profile "web" + bundles [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app]',
    '# 覆盖的面: **只有 base + web-app 两层**。内置实例真实 profile 是 9 个 bundle，',
    '#           第三方那些（dsh-browser-plus / @linxin666/dsh-web-all …）**不出现在本文件里**。',
    '# 规模   : ' + rows.length + ' 行 / 带 disabled 的 ' + withDisabled.length
      + ' 行（其中 !!js 表达式 ' + expr.length + ' 行）',
    '# 用途   : tests/dsh-assembly-probe.test.js 的**解析器回归基线**（上游改格式时先红在这里）',
    '# 纪律   : 本文件**只由** scripts/dsh-fixture-freshness.js --write 生成；手改必被门禁打红',
    '# ------------------------------------------------------------------',
    ''
  ].join('\n');
}

function parseArgs(argv) {
  const a = { write: false, json: false, vendor: null, fixture: null };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s === '--write') a.write = true;
    else if (s === '--json') a.json = true;
    else if (s === '--vendor') a.vendor = argv[++i];
    else if (s === '--fixture') a.fixture = argv[++i];
    else { console.error('error: 未知参数 ' + s); process.exit(1); }
  }
  return a;
}

/** 现跑一次 `--dump-config`：隔离 home 落在系统临时目录（**不碰** dsh-home），跑完必删 */
function compose(vendorDir) {
  const nodeExe = path.join(vendorDir, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
  const binJs = path.join(vendorDir, 'app', 'lib', 'bin.js');
  if (!fs.existsSync(nodeExe) || !fs.existsSync(binJs)) return { code: 3, error: NO_VENDOR_MSG + '（' + vendorDir + '）' };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fresh-'));
  try {
    const pw = path.join(home, 'profiles', 'web');
    fs.mkdirSync(pw, { recursive: true });
    // ⚠️ 必须无 BOM：PS 的 utf8 会带 BOM，JSON.parse 直接崩（`dsh-assembly-probe.js` 踩过）
    fs.writeFileSync(path.join(pw, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true, dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } }
    }, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(pw, 'cordis.patch.yml'), '[]\n', 'utf8');
    fs.writeFileSync(path.join(pw, 'cordis.yml'), '[]\n', 'utf8');
    const r = spawnSync(nodeExe, [binJs, '--profile', 'web', '--dump-config'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: Object.assign({}, process.env, { DSH_HOME: home })
    });
    const out = (r.stdout || '') + (r.stderr || '');
    if (r.status !== 0) return { code: 1, error: '--dump-config 失败（exit ' + r.status + '）\n' + out.split('\n').slice(0, 8).join('\n') };
    return { code: 0, body: normalize(out) };
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* 清理失败不致命 */ }
  }
}

function versionOf(vendorDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(vendorDir, 'app', 'package.json'), 'utf8')).version;
  } catch (e) { return '?'; }
}

/** 第一处不一致的行号（fail 时报"第几行"，不给整篇 diff —— 见 `diffLines` 存在的理由） */
function firstDiff(have, want) {
  const a = have.split('\n'), b = want.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return { line: i + 1, have: a[i] === undefined ? '(文件结束)' : a[i], want: b[i] === undefined ? '(文件结束)' : b[i] };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const vendor = args.vendor ? path.resolve(args.vendor) : path.join(ROOT, 'vendor', 'dsh');
  const fixturePath = args.fixture ? path.resolve(args.fixture) : path.join(ROOT, FIXTURE_REL);

  const dump = compose(vendor);
  if (dump.code === 3) {
    // **响亮**：没有运行包时不许"跳过就算过"
    console.error('error: ' + dump.error);
    console.error('  ⇒ 本门禁需要运行包才能判定。**这不是通过** —— CI / 新克隆里没有 vendor/dsh' +
      '（.gitignore 忽略），此时只能验"它响亮报错"这一条契约。');
    process.exitCode = 3;
    return;
  }
  if (dump.code !== 0) { console.error('error: ' + dump.error); process.exitCode = 1; return; }

  const version = versionOf(vendor);
  const wantText = renderHeader(version, dump.body, FIXTURE_REL) + dump.body;

  if (args.write) {
    // 行尾口径：**沿用目标文件已有的风格**（本仓 core.autocrlf=true，该文件工作树是 CRLF）
    let crlf = false;
    try { crlf = /\r\n/.test(fs.readFileSync(fixturePath, 'utf8')); } catch (e) { /* 文件还不存在 ⇒ LF */ }
    const out = crlf ? wantText.replace(/\n/g, '\r\n') : wantText;
    fs.writeFileSync(fixturePath, out, 'utf8');
    const rows = readRows(dump.body);
    console.log('✓ 已重生成 ' + FIXTURE_REL + '（@deepseek-ai/dsh ' + version + '，' + rows.length + ' 行，行尾 '
      + (crlf ? 'CRLF（沿用原文件）' : 'LF') + '）');
    if (args.json) {
      console.log(JSON.stringify({ ok: true, wrote: true, version, rows: rows.length,
        bytes: Buffer.byteLength(out), eol: crlf ? 'crlf' : 'lf' }, null, 2));
    }
    return;
  }

  if (!fs.existsSync(fixturePath)) {
    console.error('✗ 夹具缺失：' + FIXTURE_REL + '（运行 `node scripts/dsh-fixture-freshness.js --write`）');
    process.exitCode = 1;
    return;
  }
  const have = normalize(fs.readFileSync(fixturePath, 'utf8'));
  const same = have === wantText;
  const report = {
    ok: same, version, rows: readRows(dump.body).length,
    fixtureBytes: fs.statSync(fixturePath).size
  };
  if (same) {
    console.log('✓ 夹具与运行包一致：' + FIXTURE_REL + '（@deepseek-ai/dsh ' + version + '，'
      + report.rows + ' 行）');
    if (args.json) console.log(JSON.stringify(report, null, 2));
    return;
  }
  const d = firstDiff(have, wantText);
  console.error('✗ 夹具与运行包**不一致**：' + FIXTURE_REL);
  console.error('  运行包 @deepseek-ai/dsh ' + version + ' 现跑合成树 = ' + report.rows + ' 行');
  console.error('  第一处差异在第 ' + d.line + ' 行：');
  console.error('    磁盘: ' + String(d.have).slice(0, 160));
  console.error('    应为: ' + String(d.want).slice(0, 160));
  console.error('  → 运行包变了就重生成：`node scripts/dsh-fixture-freshness.js --write`');
  console.error('  → **不要手改**：本文件只由该命令写（出处头里的行数也会一起对上）');
  if (args.json) console.log(JSON.stringify(Object.assign(report, { firstDiff: d }), null, 2));
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { readRows, splitFixture, renderHeader, normalize, firstDiff, compose, versionOf,
  FIXTURE_REL, NO_VENDOR_MSG, BODY_START_RE };
