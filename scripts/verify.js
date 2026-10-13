#!/usr/bin/env node
/* ============================================================
 * scripts/verify.js — 验证链运行器（含**耗时预算**门禁）
 * ------------------------------------------------------------
 * 为什么把 `&&` 链换成这个脚本：
 *   本工程花了很大力气把 `npm run verify` 从 **176 s 压到 ~77 s**（单是把集成断言从
 *   "每条起一个 Node 进程"改成就地调用就省下 98 s）。但这种收益**没有任何东西守得住** ——
 *   下一个人以"多加一条断言""多挂一个脚本"的名义，很轻松就能把它一点点涨回去，
 *   而且**每次只涨一点点，没人会注意到**。这与本工程反复修过的那类病同型：没做坏事，
 *   却也让坏事看不出发生。
 *   ⇒ 把耗时的**数量级**变成红，并让每次运行都打印耗时表（时间花在哪，一眼可见）。
 *
 * 两个设计要点：
 *   ① **stdio: 'inherit'，不用管道**。受限环境（企业 EDR / 沙箱）禁止管道 stdio，
 *      用管道收集输出会让整条链假失败 —— 本工程的 `docs/VERIFY.md`「本机受限环境注意」
 *      记着这个坑。inherit 还顺带让子步骤的输出**实时**可见（而不是跑完才吐）。
 *   ② 预算取实测的 **2–3 倍**，是**止涨线**而不是性能目标。刻意留足余量：CI 与本机负载
 *      差异很大，紧贴实测值会变成随机红灯，而随机红灯的下场是被人无视或直接删掉。
 *
 * 覆盖面（一条事实只写一处）：本文件的 `STEPS` 同时是
 *   · `npm run verify` 的执行顺序；· `docs/VERIFY.md` 里那张验证链表的数据源
 *   （由 `scripts/doc-facts.js` 渲染）。改步骤只改这里。
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
// 改动面 → 必跑集的映射（纯函数 + 单测；本文件只负责取清单、跳过与留痕）
const changedPlan = require('./changed-plan.js');

const ROOT = path.resolve(__dirname, '..');

/* ================================================================
 * ⚠️ **非确定性产物**（生成器就是本文件）—— 下面这几个**不得当真值**读：
 *   · `.review/verify-tests.json`     vitest 报告（含每个文件的耗时），只是"用例数"的交接文件
 *   · `.review/last-verify.json`      每次运行都不同（finishedAt / totalMs / freeMemMB / version）
 *   · `.review/verify-history.jsonl`  **追加式**历史（同上 + node / host / freeMemMB）
 *   它们是**留痕**，回答的是"上次绿没绿、比上次慢了没有"；要**当前真值**就现场取：
 *   `node scripts/doc-facts.js`（命令数 / 工具数 / 用例数 / 断言数）。
 *   差异来源属于「时间戳 / 耗时 / 路径」三类 —— 逐类的"为什么可以不确定"见门禁 **S3**
 *   （`node scripts/determinism-check.js --list`）。**判定**：标注缺了、或标注没点名产物，都会判红。
 * ================================================================ */

/** 第 4 步额外产出的用例数（供第 6 步取用，省掉它重跑一次 vitest）。
 *  落在 `.review/` —— 工程既定的**工作产物区**（已 gitignore，G8 豁免）。 */
const TEST_RESULTS = '.review/verify-tests.json';

/** 从 vitest 的 JSON reporter 输出里取用例总数；读不到就返回 null（下游会自己跑一遍） */
function readUnitTests(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(j.numTotalTests) ? j.numTotalTests : null;
  } catch (e) { return null; }
}

/* ---------------- 交接面留痕：上一次全链的结果 ----------------
 * 为什么需要：零上下文的接手演练（只读文档、不跑重命令）**无法回答"上一次验证绿没绿"** ——
 * 工程里没有任何落盘痕迹。这对"AI 独立接手"是直接缺口：新会话要么盲跑一次全链（50 s+），
 * 要么在不知道基线的情况下改代码。
 * 落在 `.review/`（工作产物区：已 gitignore、不进 G6、G8 豁免）——**丢了就当"未知"**，不判红。
 * 注意：它只是"上一次跑过"的记录，**不是**"当前代码已验证"的证明（代码可能又改过了）。 */
const LAST_VERIFY = '.review/last-verify.json';

function readLastVerify() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, LAST_VERIFY), 'utf8'));
    return (j && typeof j.finishedAt === 'string') ? j : null;
  } catch (e) { return null; }
}

function writeLastVerify(run) {
  try {
    const p = path.join(ROOT, LAST_VERIFY);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(run, null, 2) + '\n', 'utf8');
  } catch (e) { /* 写不进去不影响验证结论 */ }
}

/* ---------------- 验证历史：**追加**，不覆盖 ----------------
 * 为什么需要：`last-verify.json` 每次运行都被**覆盖**，只剩最后一条记录。而验证链的真实故障
 * 恰恰多是"可疑的偶发 / 变慢"：2026-09-30 一晚连跑 6 次，症状每次都不一样。跑完只剩最后一条 ⇒
 * **事后无从查证**"是偶发还是真的变慢了"（几次记录摆在一起，规律一眼可见；只剩一条就什么都看不出）。
 * 为什么用 JSON Lines：一行一条、追加不覆盖、坏一行不毁前面所有行，用 `Get-Content | ConvertFrom-Json`
 * 或普通文本工具就能读，不需要任何依赖（工程**零必需运行时依赖**，唯一例外是 PDF 解析用的
 * `pdfjs-dist` —— 它只在 `scripts/pdf-outline-helper.mjs` 那个子进程里载入）。
 * 为什么带 node / host / freeMemMB：这三点是"同一份代码、结果不同"时最先要排除的变量
 * （node 版本差异、换机器、当时内存压力）。
 * 为什么写失败不能影响结论：它只是**旁证**（与 `last-verify.json` 同一性质）。为了一条日志把一次
 * 真实验证判成失败，属于"辅助设施反过来打断主流程"，得不偿失 ⇒ 只打印一行警告。
 * 落在 `.review/`（工程既定的**唯一杂物区**：可随时整目录删除、已 gitignore、不进 G6 数字扫描）。 */
const VERIFY_HISTORY = '.review/verify-history.jsonl';

/** 一条历史记录（除 `envIn` 外都是纯计算：便于单测"字段映射"那一半） */
function buildVerifyHistory(run, results, envIn) {
  const env = envIn || { node: process.version, host: os.hostname(), freeMemMB: Math.round(os.freemem() / 1048576) };
  return {
    at: run.finishedAt,                       // ISO 时间（与 last-verify.json 同一个时刻，便于两份记录对齐）
    ok: run.ok,
    failedGate: run.failedGate === undefined ? null : run.failedGate,
    totalMs: run.totalMs,
    // `--changed` 的部分验证要标出来：它**不能**当耗时基线（只跑了几步，比出来是假信号 ✗）
    partial: run.partial === true,
    // 每步：门禁 / 耗时 / 退出码 / 是否超预算。另外带上 skipped（G7 与 G6 共用一次调用时 ms=0）——
    // 免得事后看历史时把"这一步没单独跑"误读成"耗时 0 秒、很健康"。
    steps: results.map((r) => ({
      gate: r.gate,
      ms: r.ms,
      code: r.code,
      overBudget: r.budgetMs > 0 && r.ms > r.budgetMs,
      skipped: r.skipped === true
    })),
    node: env.node,
    host: env.host,
    freeMemMB: env.freeMemMB
  };
}

/** 追加写一条历史（失败只警告，绝不让 verify 因此失败）。 */
function writeVerifyHistory(run, results) {
  try {
    const p = path.join(ROOT, VERIFY_HISTORY);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(buildVerifyHistory(run, results)) + '\n', 'utf8');
  } catch (e) {
    console.warn('⚠️ 验证历史写入失败（不影响本次验证结论）：'
      + VERIFY_HISTORY + ' —— ' + (e.message || e));
  }
}

/* ---------------- 度量列：这次比上次快了多少（2026-10-08 加） ----------------
 * 为什么加：本链有过一次真实的教训 —— 从 176 s 压到 77 s 之后**又慢慢涨回去**
 *（`01` 里记的 70 s 与后来的 118 s 就是同一件事的两个时点）。只打印"本次耗时"看不出趋势，
 * 于是"这轮省下的"没人知道、也就没人守 ⇒ 每次运行时直接把**与上一条历史的差**打出来 ✓。
 * 读历史必须在**追加本次记录之前**（就在打印耗时表那一刻）✓ 否则比的是自己。
 * 阈值只提示不判红：耗时受负载影响（本机实测同一份代码能差 20%+），判红交给预算 ✓。 */

/** 从历史行里挑**对比基线**：最后一次 `ok:true` 的那条（纯函数，便于单测）。
 *  ⚠️ 为什么不能拿"最后一条"：**失败/中断的那次步骤压根没跑完** ⇒ 逐门禁比出来是假信号。
 *  实测踩到：一次在 G4 中断的运行（合计 23.7s）让下一次全链显示"比上次慢了 +101.7s" ✗。 */
function pickHistoryBaseline(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!String(lines[i]).trim()) continue;
    try {
      const r = JSON.parse(lines[i]);
      // `partial`（--changed 的部分验证）同样不能当基线 —— 它只跑了几步，比出来是假信号 ✗
      if (r && r.ok === true && r.partial !== true && Array.isArray(r.steps)) return r;
    } catch (e) { /* 坏行跳过：历史上可能有半截行 */ }
  }
  return null;
}

/** 读历史文件的对比基线（读不到/没有成功的记录 ⇒ null，绝不因此让 verify 失败） */
function readHistoryBaseline() {
  try {
    const text = fs.readFileSync(path.join(ROOT, VERIFY_HISTORY), 'utf8');
    return pickHistoryBaseline(text.split(/\r?\n/));
  } catch (e) {
    return null;
  }
}

/* ---------------- `--changed`（改动面 → 必跑集，2026-10-08 加） ----------------
 * 映射规则在 `scripts/changed-plan.js`（纯函数、有单测）；这里只做三件事：
 *   ① 取改动清单（git 的 I/O）；② 按计划**跳过**不在计划里的步骤；
 *   ③ 把"这是**部分**验证"写进**另一个**记录位 —— **绝不覆盖** `last-verify.json`
 *      （那句话回答的是"上一次**全链**绿没绿"，被一条只跑了 4 步的记录覆盖就变成假事实 ✗）。 */
const LAST_VERIFY_CHANGED = '.review/last-verify-changed.json';

/** 工作区改动（含未跟踪文件）；取不到 git ⇒ null（调用方退回全量） */
function changedFiles() {
  const run = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  try {
    const diff = run(['diff', '--name-only', 'HEAD']);
    if (diff.status !== 0) return null;
    const untracked = run(['ls-files', '--others', '--exclude-standard']);
    const files = String(diff.stdout || '').split(/\r?\n/)
      .concat(String(untracked.stdout || '').split(/\r?\n/));
    return files.map((f) => f.trim()).filter(Boolean);
  } catch (e) { return null; }
}

/** 部分验证的记录（单独一格：不覆盖"上次全链"） */
function writeLastVerifyChanged(run) {
  try {
    const p = path.join(ROOT, LAST_VERIFY_CHANGED);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(run, null, 2) + '\n', 'utf8');
  } catch (e) { /* 记录写失败不影响结论 */ }
}

/** 读部分验证那格（供开头一句"另有上次部分验证"） */
function readLastVerifyChanged() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, LAST_VERIFY_CHANGED), 'utf8')); }
  catch (e) { return null; }
}

/** 与上一条历史逐门禁比较（纯函数，便于单测）。
 *  `skipped` 的步骤（与上一步共用一次调用）不参与比较 —— 它的 ms 是 0，比出来是假信号 ✗ */
function historyDelta(prev, results, currentTotalMs) {
  if (!prev || !Array.isArray(prev.steps)) return null;
  const byGate = {};
  for (const s of prev.steps) if (s && s.gate) byGate[s.gate] = s;
  const out = { byGate: {}, total: null };
  for (const r of results) {
    if (r.skipped) continue;
    const p = byGate[r.gate];
    if (!p || p.skipped || typeof p.ms !== 'number') continue;
    out.byGate[r.gate] = { ms: p.ms, deltaMs: r.ms - p.ms };
  }
  if (typeof prev.totalMs === 'number' && typeof currentTotalMs === 'number') {
    out.total = { ms: prev.totalMs, deltaMs: currentTotalMs - prev.totalMs };
  }
  return out;
}

/** 差的显示形式：**总是带符号**（"+7.6s" / "-12.3s"），负=变快 ✓ */
function fmtDelta(ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return '—';
  const s = ms / 1000;
  return (s > 0 ? '+' : s < 0 ? '-' : '±') + Math.abs(s).toFixed(1) + 's';
}

/* ---------------- 兜底备份的新鲜度（只提示，不判红） ----------------
 * 为什么需要：**两件互相替代不了的事**必须都看着 ——
 *   ① **本地回滚**（本地 Git 有没有提交）：改了能回去；
 *   ② **工程外备份**（`D:/backup/...` 有没有东西）：磁盘/整个目录丢了还能起。
 * 2026-09-29 起 ① 已具备（`.git/objects` 的 EDR 拦截解除，见 `docs/INCIDENTS.md`），但 ② 仍然缺 ——
 * 而**本地提交救不了磁盘丢失**（`.git` 就在同一块盘上）。所以这条提示不能因为"有 Git 了"就删掉，
 * 只能把"零提交"那句**已经过时的前提**改对（它原先是"Git 零提交 ⇒ export-json 是唯一手段"，
 * 现在两者是**两个独立的兜底**，各自都要看）。
 * 这里只做"提醒"，因为"该不该现在备份"是人的判断（M1：损害高但动作可具体描述 ⇒ 提示 + 约定）。 */
const BACKUP_DIRS = ['D:/backup/ai-mind-map', 'D:/backup'];

/** 本地 Git 有几条提交。0 = 没有可用历史；null = 取不到（没装 git / 不是仓库 / 超时） */
function gitCommitCount() {
  try {
    // stdio 用管道是安全的：这里只为读数，且不经过被测脚本（与文件头①那条"别用管道收集被测进程输出"无关）
    const r = spawnSync('git', ['rev-list', '--count', 'HEAD'],
      { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
    if (r.status !== 0) return 0;
    const n = parseInt(String(r.stdout || '').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch (e) { return null; }
}

function checkBackupFreshness() {
  let newest = 0;
  for (const d of BACKUP_DIRS) {
    try {
      for (const f of fs.readdirSync(d)) {
        const st = fs.statSync(path.join(d, f));
        if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
      }
    } catch (e) { /* 目录不存在即跳过 */ }
  }
  return newest ? { at: newest, days: Math.round((Date.now() - newest) / 86400000) } : null;
}

/**
 * 验证链的唯一定义。字段：
 *   step    步号     gate 门禁编号（见 docs/RULES.md §2）  label 简称
 *   cmd     实际执行（给 runner）    shown 给人看的等价命令（写进 VERIFY.md）
 *   covers  覆盖什么（写进 VERIFY.md）
 *   budgetMs 该步预算（止涨线，见文件头②）
 *
 * 【2026-09-30 调整：数组顺序与门禁编号**不再一致**，这是有意的】
 * 执行顺序 = 数组顺序（runner 就是按这个数组跑的），门禁编号只是名字，不表示先后。
 * 为什么把"生成物类"检查提到前面（G8 → G9 → G3 → G6 → G7）：
 *   它们便宜（合计 < 3 s）、而且它们红了往往要**回头改文档 / 补元信息 / 重跑 `npm run facts:write`** ——
 *   放在链末，就意味着改了预算而忘了 `facts:write` 时，前面的测试与冒烟（90 s+）**全部白跑一遍才报错**
 *   （2026-09-30 真实发生：一晚上连跑 6 次，每次都要等链末那句"生成物已过期" ✗）。
 *   一句话：**最可能红、又最便宜、且决定要不要回头重做的检查，排最前**。
 * 为什么不能把 G6 再往前挪到 G3 之前：
 *   G6 必须用 **G3（vitest）产出的用例数**（经 `.review/verify-tests.json` 传入），否则它会退化去
 *   自己重跑一次 vitest（慢约 5–9 s，而且那一次在负载高时偶发取不到真值 ⇒ G6 假红）。
 *   ⇒ 顺序约束是"**G3 之后、但仍要早于昂贵步骤**"，所以落在第 5 位。
 * 改动本数组（顺序 / 命令 / 预算）时**必须同批**跑 `npm run facts:write`：
 *   `docs/VERIFY.md` 的链路表与合计预算由本数组渲染（`scripts/doc-facts.js`），不同批重生成
 *   ⇒ G6/G7 判"生成物已过期" ✗ —— 而按上面的新顺序，它会在**廉价步骤里就红**（这正是目的，
 *   不是故障；但**别把它当成可以留到下次的债**）。
 */
const STEPS = [
  {
    step: 1, gate: 'G1', label: '编码完整性',
    cmd: 'node scripts/encoding-check.js', shown: '`npm run check:encoding`',
    covers: '文件编码完整性：UTF-8 BOM / U+FFFD / 经典乱码特征',
    budgetMs: 10000
  },
  {
    step: 2, gate: 'G8', label: '文档登记与家门',
    cmd: 'node scripts/docs-registry-check.js', shown: '`npm run check:docs`',
    covers: '文档登记与家门：表外文档 / 散落文档 / 工程根与顶层目录乱放 / 悬挂登记'
      + '（登记表 = `docs/ARCHITECTURE.md` §5；工作产物区 = `.review/`）',
    budgetMs: 10000
  },
  {
    step: 3, gate: 'G9', label: '规则文件自洽',
    cmd: 'node scripts/rules-consistency.js', shown: '`npm run check:rules`',
    covers: '规则文件自洽：声明条数 == 表格行数 / 表格未被引用块或空行打断 / 编号引用闭合 / 实现列点名的脚本存在',
    budgetMs: 10000
  },
  {
    step: 4, gate: 'V1', label: '可见性判据',
    cmd: 'node scripts/visibility-judge-check.js', shown: '`node scripts/visibility-judge-check.js`',
    covers: '冒烟断言**判据的来源**：名字里声称"可见/看不见/遮挡/在框外/在面板内"的断言，'
      + '必须有真判据（`elementFromPoint` 命中测试 / `scanRegion` 等真帧像素）或一行显式豁免'
      + '（`判据-豁免: <原因>`）—— 只用 rect / 类名 / `style.display` 判"可见"的断言对**裁切与遮挡是盲的**'
      + '（实测：同一元素被 `overflow:hidden` 裁掉时 rect 读数与正常显示完全相同，而真帧像素 81 vs 768）',
    // 纯文本扫描（37 个冒烟域文件，实测 ≈0.3 s）⇒ 按本文件惯例取实测的十几倍仍是 10 s 档（廉价门禁）
    budgetMs: 10000
  },
  {
    step: 5, gate: 'V2', label: '冒烟域内自收尾',
    cmd: 'node scripts/smoke-state-check.js', shown: '`node scripts/smoke-state-check.js`',
    covers: '冒烟**域内自收尾**（跨域状态污染）：凡是会**留下浮层/模态**的动作（`addNode`/`addTopic` 会顺手'
      + '打开「编辑节点」框；`openFilePreview`/`openAudit`/`openPalette`/… 各自留下浮层），域末必须给出收尾'
      + '（共用入口 `closeDialogs(ctx)`，或产品自己的关闭口）或写一行豁免 —— 而"每域隔离"收不掉 DOM 模态'
      + '（它只还原项目数据 + 重开项目）⇒ 模态会跨域存活、盖住后面域的画布'
      + '（实测：域 16 一处漏关 ⇒ 域 36/37 连锁红 11 条，而那两个文件一行都没改过 ✗）。'
      + '运行时兜底是 main.js 的"域开始的干净前置"（有残留 ⇒ 该域判红并**点名是哪个域留下的**）',
    // 纯文本扫描（37 个文件，与 V1 同量级）⇒ 10 s 档
    budgetMs: 10000
  },
  {
    step: 6, gate: 'S1', label: '单向依赖',
    cmd: 'node scripts/dep-direction-check.js', shown: '`node scripts/dep-direction-check.js`',
    covers: '**单向依赖**（声明在 `docs/ARCHITECTURE.md` §4 原则 2：renderer → main/scripts → cli → src，'
      + '不反向依赖）：扫第一方源码的 `require`/`import` 边，按**单源分层图**（本门禁的 `LAYERS`，只写一处）'
      + '判方向 —— **反向边即红并指名 `A → B`**，同层成环与"指向分层图之外"也判红（在册豁免除外）。'
      + '它守的正是 skill 点名的"性质成立、检查没建"那一类：这条约束一直成立（实测零回边），'
      + '但**一次顺手 `require` 就能破而全链不红** ✗',
    // 纯文本扫描 + 一行 require 解析（实测 ≈0.1 s）⇒ 取十几倍仍是 10 s 档（廉价门禁）
    budgetMs: 10000
  },
  {
    step: 7, gate: 'S2', label: '连带清单',
    cmd: 'node scripts/collateral-check.js', shown: '`node scripts/collateral-check.js`',
    covers: '**改动即连带清单**：把"改动类型 → 连带处"做成**单源表**（本脚本的 `COLLATERAL`），'
      + '并对其中**尚未机制化**的那几处直接断言（① MCP 派发到的每条 CLI 命令都必须存在；'
      + '② 每个冒烟域都必须在断言注册面的索引里）；已机制化的那几处（G8 / G7 / G6 / V2 / V1 / G8 第 ⑮ 条…）'
      + '**指过去复用**，只校验那个门禁真的挂在链上 ✗ 不重做。`--list` 现场打印全表（报错即指路）',
    budgetMs: 10000
  },
  {
    step: 8, gate: 'S3', label: '确定性产物',
    cmd: 'node scripts/determinism-check.js', shown: '`node scripts/determinism-check.js`',
    covers: '**确定性产物**（判据 `A-08`）：产物登记表（声明面 = `docs/ARCHITECTURE.md` §5.2，双向闭包）里'
      + '**真值比**的产物必须"同一状态**连续两次**重算逐字节相同"（含时钟 / 随机 / 顺序 / 工作区四类扰动，'
      + '差异来源可分类）；**允许不确定**的产物必须在生成器里**点名标注**"非确定性、不得当真值"；'
      + '自述是生成物却没进表的一律判红。**乙档上线**：被当证据真值用、但判定尚不存在的那些住在'
      + '**门禁侧的封闭欠账册**里（`--debt` 现场取，只减不增，修好忘销账或册上对象不存在都判红）',
    budgetMs: 10000
  },
  {
    step: 9, gate: 'G3', label: '单元测试',
    // 与 `npm test` 等价，**外加** JSON reporter：把用例数交给第 10 步（doc-facts），
    // 于是整条链只需要跑**一次** vitest（以前 doc-facts 会再跑一次：慢约 5 s，
    // 而且正是那一次在负载高时偶发取不到真值、把 G6 判红）。
    // `--reporter=default` 保留人看的输出，故这一步的观感与 `npm test` 一致。
    cmd: 'node node_modules/vitest/vitest.mjs run --pool=threads --reporter=default '
      + '--reporter=json --outputFile=' + TEST_RESULTS,
    shown: '`npm test`（附加 JSON reporter 把用例数交给 G6，省一次 vitest 重跑）',
    covers: '共享核心 `src/` 各模块（含 data-store 原子写、BOM 容错与并发版本闸门）',
    budgetMs: 60000,
    resultsFile: TEST_RESULTS
  },
  {
    step: 10, gate: 'G6', label: '文档数字与版本一致',
    cmd: 'node scripts/doc-facts.js --check', shown: '`node scripts/doc-facts.js --check`',
    covers: '文档数字与真值一致（含**第一屏 `SKILL.md` 自报的验证链步骤数** == `STEPS.length`）、版本号四处一致',
    // 20 s：正常情况（采用链上用例数）约 0.7 s；**交接失效退化为自跑 vitest 时约 9.2 s**
    // 仍容得下，但更严重的退化会被抓住。
    budgetMs: 20000,
    useUnitTests: true // 由第 9 步（G3）传入用例数，省掉这里的 vitest 重跑
  },
  {
    step: 11, gate: 'G7', label: '生成物未过期',
    cmd: null, shown: '同上（重算比对）',
    covers: '生成物是否过期（`docs/CLI.md` 与 registry 一致）',
    budgetMs: 0 // 与 G6 同一次调用，单独不占预算
  },
  {
    step: 12, gate: 'G4', label: 'CLI 集成断言',
    cmd: 'node scripts/cli-integration.js', shown: '`node scripts/cli-integration.js`',
    covers: '全部 CLI 命令端到端（**进程内调用**，临时项目，自动清理）',
    // 预算调整史（每次都带实测依据 ✓）：
    //   · 原值 30s：按 2026-09 的实测（≈4.5–11s）取 2–3 倍余量，当时很宽 ✓。
    //   · 2026-10-13：**30s→60s**。当天实测（`.review/verify-history.jsonl` 真读数）：
    //     两次失败运行里 G4 = 26.6s / 26.5s、另一次 29.3s；最近一次成功全链（15:28）**29.5s**
    //     ⇒ 距 30s 只剩 **0.5s** ✗。而当天全机同时慢 20–30%（同几轮读数：G3 30.8→38.9s），
    //     即"30s 预算在慢档里**必然假红**"（29.5×1.2 ≈ 35s）：判据全绿、只是机器慢，
    //     却以"CLI 集成断言太慢"的形状报出来 —— 那不是止涨线，是随机红灯 ✗（与 G5 那次同型）。
    //     60s = 快档基线 23.8s 的 **2.5×**、慢档 29.5s 的 **2.0×** ⇒ 先止住假红，
    //     再由"预算 = 止涨线"抓真正的变慢（真涨到 60s+ 仍然红 ✓）。
    //   · ⚠️ 只有**这一步**的预算动了：其余步骤原值不动，G5 的 450s 与 main.js 的守卫 540s 也未动 ✓。
    budgetMs: 60000
  },
  {
    step: 13, gate: 'G2', label: '数据校验',
    cmd: 'node cli/mm-cli.js validate-all', shown: '`node cli/mm-cli.js validate-all`',
    covers: '全部项目结构 + 悬挂链接 + 环',
    budgetMs: 15000
  },
  {
    step: 14, gate: 'G5', label: '冒烟（Electron 无头）',
    cmd: 'npm run smoke', shown: '`npm run smoke`',
    covers: '渲染层（Electron 无头，含监听器泄漏回归）+ **真实数据隔离**',
    // 预算调整史（每次都带实测依据 ✓）：
    //   · 2026-09-29：22-* / 23-* 要**真建原生侧栏 view**，实测 130.7s ⇒ 120s 不成立 ⇒ 150s。
    //   · 2026-09-30：查明那三条断言的耗时大头是**顺手孵化了一个真的内置 DSH 服务**
    //     （40–60s，且随负载抖到 172.7s ⇒ 同代码 94.9s 绿 / 172.7s 被守卫掐红 ✗）；
    //     冒烟模式改 `setNoSpawn(true)`（不孵化、也不接管用户的服务 ✓）后只要 11.5s ✓
    //     ⇒ 预算收回 150s（仍是实测的 2 倍余量）。
    //   · 2026-10-08：每域隔离改为**默认开**（正确语义 ✓，见 main.js 的 smokeIsolate）⇒ 实测
    //     155.1s（另一次 164.7s；隔离让 12 个域各多一次"还原 + 重载"）⇒ 150s 已不成立 ✗。
    //     预算按本文件惯例（实测的 ~2 倍）设为 320s —— 仍是止涨线，不是性能目标 ✓。
    //     想临时跑快：MM_SMOKE_NO_ISOLATE=1（**只用于诊断** ✗，那时结果不再是全量真值口径）。
    //   · 2026-10-13：预算 320s→**450s**。当天两次全链都是
    //     **判据没错、被自己的守卫掐断**：G5 实测 **304.6s / 304.6s**（合计 375.0 / 377.0s），
    //     报文里只有 `SMOKE GUARD TIMEOUT — force exit`（无 FAIL/THREW），而 main.js 的守卫当时是 300s ✗。
    //     结构性原因：320s 对**同一天的绿链读数** 243.6 / 248.8 / 246.1 / 250.4s（07:32–09:42 四次）
    //     只有 1.28–1.31× 余量 ⇒ 那不是止涨线，是**随机红灯**；而当天全机同时慢 20–30%
    //     （同两次运行里 G3 30.8→38.9s、G4 23.8→26.5s，幅度同向同量级）⇒ 贴线必然偶发假红。
    //     450s = 基线 250s 的 **1.8×**，同时高于已实测到的 304.6s（1.48×）⇒ 慢机器不再假红，
    //     而"悄悄涨回 400s+"仍然会被抓住（本文件惯例：预算取实测 2 倍上下，是止涨线不是性能目标）。
    //     配套：`main.js` 的冒烟守卫同步 300s→**540s**（= 450 × 1.2）。
    //     **不变量：守卫 > 预算** —— 预算判"太慢"（止涨线、判红时带读数与差额），
    //     守卫只拦"真挂死"（没读数、只能强杀）；守卫先触发会把"跑完了、判据全绿、只是机器慢"
    //     报成崩溃（正是本次两红的形状）⇒ 两者代价不对等，守卫**必须永远大于本步预算** ✓。
    budgetMs: 450000
  }
];

/** 整链预算（止涨线）。
 *  2026-09-30：实测 ~100–120 s ⇒ 取 180s。
 *  关键修复记录：侧栏那三条断言（22-、23-、24-）原先会顺手**孵化一个真的内置 DSH 服务**
 *  （40–60 s，且随机器负载抖到 172.7 s ⇒ 同一份代码 94.9 s 绿 / 172.7 s 被守卫掐红 ✗）；
 *  冒烟模式改成 `setNoSpawn(true)`（既不孵化也不接管用户的服务 ✓）后，它们只要 11.5 s ✓。
 *  2026-10-08：每域隔离改为**默认开**（正确语义 ✓；见 main.js 的 smokeIsolate）⇒ 全链实测
 *  197.8s ⇒ 180s 已不成立 ✗ ⇒ 按实测 ~2 倍取 400s。隔离买到的是「同一份代码稳定复现」，
 *  值这个时间 ✓（想临时跑快：MM_SMOKE_NO_ISOLATE=1，**只用于诊断** ✗）。
 *  2026-10-13：**400s→700s**，并补一条结构性依据（原先没人写下来）：
 *  **合计预算必须 ≥ 各步预算之和** —— 否则"每步都接近各自预算"的那一刻，会**先由合计报红**，
 *  把真正慢的那一步盖掉 ✗（合计红只说"整条链慢了"，说不出是哪一步）。
 *  新账：各步预算之和 = **685s**（G4 30→60s 之后；G5 一个就 450s）⇒ 旧 400s 连**一步**的预算
 *  都容不下（G5 顶到 450s ⇒ 必然同时触发合计红）；700s 才让"单步先发声"成立 ✓。
 *  实测依据：2026-10-13 全链实测 375.0 / 377.0s ⇒ 700s ≈ 1.86×；而"每步都顶到预算"的
 *  极端总和 685s < 700s ⇒ 合计不会抢在单步前面报红 ✓。
 *  ⚠️ 上面两条不变量**不只是注释**（批 J，2026-10-13）：`tests/verify-budget.test.js` 里各有一条
 *  **机械守卫** —— 它从 `main.js` 现读冒烟守卫、从本 `STEPS` 现算各步预算之和再断言（**不抄数字**）。
 *  ⇒ 以后改任何一步的预算，**必须同批**让这两条关系继续成立，否则单测直接红（而不是等下一批
 *  真的踩到时才发现 ✓）。 */
const TOTAL_BUDGET_MS = 700000;

const fmt = (ms) => (ms / 1000).toFixed(1) + 's';

/**
 * 纯函数：把「实测结果」与「预算」比对，返回超预算项与汇总。
 * 抽成纯函数是为了能单测 —— 计时本身不可单测，但**判定逻辑**可以。
 * @param {Array<{step:number,gate:string,label:string,ms:number,code:number,budgetMs:number,skipped?:boolean}>} results
 * @param {number} totalBudgetMs
 */
function checkBudgets(results, totalBudgetMs) {
  const ran = results.filter((r) => !r.skipped);
  const totalMs = ran.reduce((n, r) => n + r.ms, 0);
  const overStep = ran.filter((r) => r.budgetMs > 0 && r.ms > r.budgetMs);
  const overTotal = totalMs > totalBudgetMs;
  return { totalMs, overStep, overTotal, totalBudgetMs, ranCount: ran.length };
}

/**
 * 打印「超预算」报表（**只打印，不决定退出码** —— 退出码归调用方）。
 *
 * 为什么抽成函数（批 J，2026-10-13）：原先这段**写在"某步失败已 return 之后"** ⇒
 * **失败步骤抢先返回，预算判定整段不执行** ✗（批 G 的两次红就是这个形状：报文里只剩
 * `SMOKE GUARD TIMEOUT — force exit`，没有任何"哪一步、超了多少"的读数）。而"某步失败"
 * 与"某步变慢"常常同源（跑到被守卫掐 / 超时 / 真挂死）⇒ 最需要看读数的那一次，恰恰没有读数。
 * 现在两条路径共用这份报表，**语义不变**：失败仍以失败报文与 exit 1 收口。
 *
 * @param {{overStep:Array,overTotal:boolean,totalMs:number,totalBudgetMs:number,ranCount:number}} chk checkBudgets 的返回
 * @param {{stepsOnly?:boolean, note?:string}} opts stepsOnly ⇒ **合计不作判定**（链没跑完时合计不是真值 ✗）
 * @returns {boolean} 是否打印了超预算内容（调用方据此说一句"没有一步超预算"）
 */
function printOverBudget(chk, opts) {
  const o = opts || {};
  const totalOver = o.stepsOnly ? false : chk.overTotal;
  if (!chk.overStep.length && !totalOver) return false;
  console.error('验证链超出耗时预算（' + chk.overStep.length + ' 步 + ' + (totalOver ? '合计' : '0') + '）：');
  for (const r of chk.overStep) {
    console.error('  [超预算] ' + r.gate + ' ' + r.label + ' 用 ' + fmt(r.ms)
      + '，预算 ' + fmt(r.budgetMs) + '（超 ' + fmt(r.ms - r.budgetMs) + '）');
  }
  if (totalOver) {
    console.error('  [超预算] 合计 ' + fmt(chk.totalMs) + '，预算 ' + fmt(chk.totalBudgetMs)
      + '（超 ' + fmt(chk.totalMs - chk.totalBudgetMs) + '）');
  }
  if (o.note) console.error(o.note);
  return true;
}

function main() {
  const results = [];
  let failed = null;
  let unitTestsFromChain = null; // 第 4 步产出、交给第 6 步（省一次 vitest 重跑）

  console.log('== 验证链（npm run verify）==');
  // 交接面留痕（读）：新接手的 AI 最想知道的一件事是"上一次全链到底绿没绿"
  // —— 零上下文的接手演练实测**答不出来**（没有任何落盘痕迹）。故每次运行都先报上一条。
  const prev = readLastVerify();
  console.log(prev
    ? '上次全链：' + prev.finishedAt.replace('T', ' ').slice(0, 16) + '  '
      + (prev.ok ? '✅ 通过' : '❌ 失败于 ' + (prev.failedGate || '?')) + '（' + fmt(prev.totalMs) + '）'
    : '上次全链：（无记录 —— 这是本机第一次跑，或 `.review/` 被清理过）');
  // 部分验证（--changed）单独一格：**不能**拿它当"上次全链"，但也不能完全不提（免得以为没跑过）
  const prevPartial = readLastVerifyChanged();
  if (prevPartial) {
    console.log('另有上次**部分**验证：' + String(prevPartial.finishedAt).replace('T', ' ').slice(0, 16) + '  '
      + (prevPartial.ok ? '✅ 通过' : '❌ 失败于 ' + (prevPartial.failedGate || '?'))
      + '（' + fmt(prevPartial.totalMs) + '，只跑计划内的步骤 —— **不是全链结论**）');
  }
  // 并发改动检测（只告知，不判红）：本工程**同时会有多个 AI 会话在改**（实测被回退过两次）。
  // 数据层有版本闸门（ADR），文档层没有 —— 这里至少把"最近有谁在动"摆到台面上。
  try {
    const rc = require('./docs-registry-check.js');
    const recent = rc.recentlyChanged(ROOT, rc.RECENT_WINDOW_MIN);
    if (recent.length) {
      console.log('ℹ️ 最近 ' + rc.RECENT_WINDOW_MIN + ' 分钟内有改动的受管文件：' + recent.length
        + ' 个（' + recent.slice(0, 5).join('、') + (recent.length > 5 ? ' 等' : '')
        + '）—— 若有另一个会话在写，跑完请复核自己的改动还在不在。');
    }
  } catch (e) { /* 检测失败不影响验证 */ }

  // ── `--changed`：按改动面裁掉用不着的步骤（映射规则见 scripts/changed-plan.js）──────
  // 设计要点：**它是提速工具，不是验收工具** —— 所有输出都带"部分验证"横幅，
  // 记录写进另一个格子（不覆盖 last-verify.json），历史标 partial（基线也不认它）。
  const changedMode = process.argv.includes('--changed');
  let plan = null;
  if (changedMode) {
    const files = changedFiles();
    if (files === null) {
      console.log('⚠️ --changed：取不到 git 改动清单（没有 git / 不在仓库里？）⇒ **退回全量**');
      console.log('');
    } else {
      plan = changedPlan.planForFiles(files);
      console.log('⚠️ == 部分验证（--changed）== **这不是全量真值**，发版/交付前请跑 `npm run verify`');
      console.log('   ' + plan.reason);
      for (const l of changedPlan.describePlan(plan)) console.log('   ' + l);
      console.log('   改动文件 ' + files.length + ' 个：'
        + (files.length > 8 ? files.slice(0, 8).join('、') + ' 等' : files.join('、')));
      if (process.argv.includes('--plan-only')) {
        console.log('   （--plan-only：只报计划，本次一步都没跑 ✓）');
        return;
      }
      if (!plan.steps.length) {
        console.log('   ⇒ 计划里没有步骤：**本次没有验证任何东西** ✓（要全量请不传 --changed）');
        return;
      }
      console.log('');
    }
  }
  console.log('');
  for (const s of STEPS) {
    // `--changed` 计划外 ⇒ 跳过（G7 是"与 G6 共用一次调用"，G6 在计划里它就跟着跑 ✓）
    const inPlan = !plan || plan.full || plan.steps.indexOf(s.gate) >= 0
      || (s.gate === 'G7' && plan.steps.indexOf('G6') >= 0);
    if (!inPlan) {
      results.push({ step: s.step, gate: s.gate, label: s.label, ms: 0, code: null,
        budgetMs: 0, skipped: true, skippedBy: 'changed' });
      continue;
    }
    if (!s.cmd) { // G7 与 G6 共用一次调用
      results.push({ step: s.step, gate: s.gate, label: s.label, ms: 0, code: null,
        budgetMs: 0, skipped: true });
      continue;
    }
    // 会产出「用例数」的步骤：先删掉上一次的结果文件。
    // 这一步是**交接可信的全部依据** —— 删过之后还读得到，就只可能是本次跑出来的。
    const resFile = s.resultsFile ? path.join(ROOT, s.resultsFile) : null;
    if (resFile) {
      fs.mkdirSync(path.dirname(resFile), { recursive: true });
      try { fs.unlinkSync(resFile); } catch (e) { /* 不存在即正常 */ }
    }

    console.log('── 步骤 ' + s.step + '／' + s.gate + '：' + s.label + ' —— ' + s.shown);
    const t0 = Date.now();
    const opts = { shell: true, stdio: 'inherit', cwd: ROOT }; // stdio: 'inherit' —— 不用管道，见文件头①
    if (s.useUnitTests && unitTestsFromChain !== null) {
      opts.env = Object.assign({}, process.env,
        { AI_MINDMAP_UNIT_TESTS: String(unitTestsFromChain) });
    }
    // 冒烟收窄：走既有的 SMOKE_ONLY（选择器会"筛错名字响亮失败"，并自标"过滤运行不是全量真值" ✓）
    if (plan && plan.smokeOnly && s.gate === 'G5') {
      opts.env = Object.assign({}, opts.env || process.env, { SMOKE_ONLY: plan.smokeOnly.join(',') });
    }
    const r = spawnSync(s.cmd, opts);
    const ms = Date.now() - t0;
    const code = r.status === null ? 1 : r.status;
    results.push({ step: s.step, gate: s.gate, label: s.label, ms, code, budgetMs: s.budgetMs });

    if (resFile) {
      unitTestsFromChain = readUnitTests(resFile);
      console.log(unitTestsFromChain === null
        ? '   （未能读到用例数 —— 第 6 步会自己再跑一次 vitest，属可接受的降级）'
        : '   （用例数 ' + unitTestsFromChain + '，已交给步骤 5（G6），省去重跑一次 vitest）');
    }
    console.log('');
    if (code !== 0) { failed = { step: s, code }; break; } // 与原 `&&` 链一致：首败即停
  }

  const chk = checkBudgets(results, TOTAL_BUDGET_MS);

  // ---- 耗时表（每次都打印：时间花在哪 + 比上次差多少，一眼可见）----
  // 基线要在**写本次记录之前**读（下面 writeVerifyHistory 才追加）✓
  // 且只认"最后一次**成功**的验证"：失败/中断的那次步骤没跑完，拿来比是假信号 ✗（实测踩过）
  const prevRun = readHistoryBaseline();
  const delta = historyDelta(prevRun, results, chk.totalMs);
  console.log('== 耗时 ==' + (delta
    ? '（对比对象：' + (prevRun.at ? String(prevRun.at).replace('T', ' ').slice(0, 19) : '上一次成功验证')
      + '；若它不是紧邻的那次，说明中间有失败/中断的验证 ✓）'
    : '（无可比历史：历史里还没有一次成功的验证 ✓）'));
  console.log('  步  门禁   耗时      预算      余量      上次      差        步骤');
  for (const r of results) {
    const pad = (v, n) => String(v).padEnd(n);
    if (r.skipped) {
      const why = r.skippedBy === 'changed' ? '（--changed 计划外：跳过）' : '（与上一步同一次调用）';
      console.log('  ' + pad(r.step, 3) + pad(r.gate, 6)
        + pad(why, 10) + ' '.repeat(8) + ' '.repeat(10) + pad('—', 10) + pad('—', 10) + r.label);
      continue;
    }
    const over = r.budgetMs > 0 && r.ms > r.budgetMs;
    const d = delta && delta.byGate[r.gate];
    console.log('  ' + pad(r.step, 3) + pad(r.gate, 6)
      + pad(fmt(r.ms), 9) + pad(fmt(r.budgetMs), 9)
      + pad(over ? '⚠ 超出' : fmt(r.budgetMs - r.ms), 9)
      + pad(d ? fmt(d.ms) : '—', 10) + pad(d ? fmtDelta(d.deltaMs) : '—', 10)
      + r.label + (r.code === 0 ? '' : '  ← exit ' + r.code));
  }
  console.log('  ' + '合计'.padEnd(9) + fmt(chk.totalMs).padEnd(9) + fmt(chk.totalBudgetMs).padEnd(9)
    + (chk.overTotal ? '⚠ 超出' : fmt(chk.totalBudgetMs - chk.totalMs)).padEnd(10)
    + (delta && delta.total ? fmt(delta.total.ms) : '—').padEnd(10)
    + (delta && delta.total ? fmtDelta(delta.total.deltaMs) : '—'));
  // 只提示不判红：耗时受负载影响（同一份代码实测能差 20%+），判红交给预算 ✓
  if (delta && delta.total && delta.total.deltaMs > 0 && delta.total.ms > 0
    && delta.total.deltaMs / delta.total.ms > 0.15) {
    console.log('  ⚠ 比上次慢了 ' + fmtDelta(delta.total.deltaMs) + '（超过上次的 15%）—— 看上面是哪一步涨的；'
      + '急涨先怀疑负载，稳涨要查根因 ✗');
  }
  console.log('');

  const partial = !!(plan && !plan.full);
  if (failed) {
    console.error((partial ? '部分验证失败（--changed）' : '验证失败')
      + '：步骤 ' + failed.step.step + '（' + failed.step.gate + '）退出码 ' + failed.code);
    /* 批 J 的账（批 G 实测）：这里原先紧接着就走记录与 return ⇒ **失败步骤抢先返回，预算判定
     * 整段不执行** ✗ —— 而"失败"与"变慢"常常同源（跑到被守卫掐 / 超时 / 真挂死），
     * 最需要看读数的那一次反而只有一句"退出码 1"。现在**失败也把预算读数打出来**；
     * 判定权仍归失败这一边，且合计**不作判定**（链没跑完 ⇒ 合计不是真值 ✓）。 */
    if (!printOverBudget(chk, {
      stepsOnly: true,
      note: '（以上是**读数**：本次以失败收口 ⇒ 预算不参与本次判定；链没跑完，合计也不作判定 ✓）'
    })) {
      console.log('预算读数：已跑的 ' + chk.ranCount + ' 步都没超过各自预算'
        + '（失败与"变慢"不同源 —— 先按上面的失败报文查原因 ✓）');
    }
    const run = {
      finishedAt: new Date().toISOString(), ok: false, failedGate: failed.step.gate,
      totalMs: chk.totalMs, version: pkgVersion(), partial,
      steps: results.map((r) => ({ gate: r.gate, ms: r.ms, code: r.code }))
    };
    // 部分验证写**另一个**格子：`last-verify.json` 回答的是"上次**全链**绿没绿"，
    // 被一条只跑了几步的记录覆盖就变成假事实 ✗（这是本工程最重的损害类别：静默）
    if (partial) writeLastVerifyChanged(run); else writeLastVerify(run);
    writeVerifyHistory(run, results);   // 历史：追加一条（可疑的偶发 / 变慢，事后靠它判）
    backupHint();
    process.exitCode = 1;
    return;
  }

  // ---- 预算判定 ----
  // 报表抽在 printOverBudget()（**只打印**），因为失败路径也要用它 —— 见那个函数上方的账 ✓
  if (printOverBudget(chk, {})) {
    console.error('');
    console.error('这不一定是错：预算的作用是**防止耗时悄悄涨回去**（本链曾从 176 s 压到 77 s）。');
    console.error('若这次增长是合理的（新增了断言/功能/步骤），请改 scripts/verify.js 的');
    console.error('STEPS 预算或 TOTAL_BUDGET_MS **并说明理由**；否则先查清为什么变慢。');
    process.exitCode = 1;
    return;
  }

  console.log((partial ? '部分验证通过' : '验证通过') + '（' + (partial ? '计划内 ' : '') + chk.ranCount + ' 步 / ' + fmt(chk.totalMs)
    + '，预算内）' + (partial ? ' —— **不是全量真值**；发版/交付前请跑 `npm run verify`' : ''));
  const run = {
    finishedAt: new Date().toISOString(), ok: true, failedGate: null,
    totalMs: chk.totalMs, version: pkgVersion(), partial,
    steps: results.map((r) => ({ gate: r.gate, ms: r.ms, code: r.code }))
  };
  if (partial) writeLastVerifyChanged(run); else writeLastVerify(run);
  writeVerifyHistory(run, results);   // 历史：追加一条（可疑的偶发 / 变慢，事后靠它判）
  backupHint();
}

/** 当前发布版本（`.review/last-verify.json` 里带上它，接手者一眼知道这份记录对应哪版） */
function pkgVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; }
  catch (e) { return null; }
}

/**
 * 兜底备份提示的**文本**（纯函数，便于单测）。
 *
 * 这段文案的要害是：**两个兜底互相替代不了**。写成"有 Git 了 ⇒ 不用备份"是危险的
 * （`.git` 与工程同盘，盘/目录丢了就一起没），写成"没备份 ⇒ 一切都完了"又忽略了
 * 本地提交已经把"改错能回去"解决了。所以两条信息**永远一起说**。
 *
 * @param {{days:number}|null} b 工程外备份的新鲜度（null = 没找到）
 * @param {number|null} n 本地提交数（null = 取不到，如没装 git / 不是仓库）
 */
function backupHintText(b, n) {
  const where = BACKUP_DIRS.join(' 或 ');
  const local = n === null ? '本地 Git 状态取不到（没装 git / 不是仓库）'
    : n > 0 ? '本地 Git 已有 ' + n + ' 条提交（**已提交**的内容可回滚）'
      : '本地 Git **零提交**（改错了回不去）';
  if (!b) {
    return 'ℹ️ 兜底备份：**未找到工程外备份**（查找 ' + where + '）｜' + local
      + '。⚠️ 本地提交**救不了**盘/目录丢失（`.git` 与工程同盘）—— 大改前建议 '
      + '`git bundle create <工程外路径> --all`（带完整历史）或 `node cli/mm-cli.js export-json`（只带当前数据）。';
  }
  if (b.days > 7) {
    return 'ℹ️ 兜底备份：最新一份在 ' + b.days + ' 天前（' + where + '）｜' + local
      + '—— 距上次备份已久，大改前建议再备一份。';
  }
  return 'ℹ️ 兜底备份：最新一份在 ' + (b.days === 0 ? '今天' : b.days + ' 天前') + '（' + where + '）｜' + local + '。';
}

/** 打印兜底备份新鲜度（只提示，不影响退出码） */
function backupHint() {
  console.log(backupHintText(checkBackupFreshness(), gitCommitCount()));
}

module.exports = {
  STEPS, TOTAL_BUDGET_MS, TEST_RESULTS, checkBudgets, readUnitTests,
  LAST_VERIFY, readLastVerify, checkBackupFreshness, BACKUP_DIRS,
  // 验证历史（追加入口 + 组记录那一半是纯函数，便于单测）
  VERIFY_HISTORY, buildVerifyHistory, writeVerifyHistory,
  // 度量列：与上一次**成功**的验证比较（纯函数 + 一个读取口，便于单测）
  pickHistoryBaseline, readHistoryBaseline, historyDelta, fmtDelta,
  // `--changed`：取改动清单、部分验证的独立记录位
  changedFiles, writeLastVerifyChanged, readLastVerifyChanged, LAST_VERIFY_CHANGED,
  // 兜底提示的两半：取数（I/O）与组文（纯函数）分开，便于单测组文那一半
  gitCommitCount, backupHintText
};

if (require.main === module) main();
