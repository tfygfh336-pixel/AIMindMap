#!/usr/bin/env node
/* ============================================================
 * scripts/pathchain-conformance.js —— 「新判据」×「现状实现」的**全量对拍**（只读读数工具）
 * ------------------------------------------------------------
 * 存在的唯一理由：把"路径 → 打开 / 预览"的判据从渲染层四处（`renderer/app-media.js` 的
 * `attachmentAbsPath`、预览头、`renderer/app-detail-content.js` 的 `openLocalPath` 与图片区）
 * 抽进 `src/path-chain.js` 时，**最重的风险不是安全、是回退**：
 * 新判据只要与 `attachmentAbsPath` **不完全等价**，就会把今天**能打开的打不开**
 * （附件是 `attachments/` 下的随机名，含中文与空格）。
 * ⇒ 这条链的**上线条件 = 差异 0**：`projects/<项目>/<项目>.json` 里**全部**路径类字段逐条过两套判据，
 *   逐条比对差异，逐条点名。
 *
 * 跑法：`node scripts/pathchain-conformance.js`（`--json` 出机器可读读数；`--project <名>` 只看一个）
 * 退出码：**0** = 报出读数且差异 0 · **1** = 有差异（**这是读数，不是工具坏了** —— 但按上线条件，
 *         有差异就不许上线，必须先定性）· **2** = **采不到真值**（项目目录读不到 / JSON 解析不了 /
 *         **ADR 的「逐类终裁」表读不到** —— 后者意味着"不纳入 + 理由"这一节没有权威可引，那同样是采不到真值）
 *
 * 三条纪律（都在实现里落了）：
 *   ① **只读**：只 `readFileSync`，一个字节都不写（`projects/**` 正被别的会话并发改写）；
 *   ② **不探存在性**：两套判据都**不做 I/O**（本机 `X:` 是不可达映射网络盘，一句 `existsSync` 要 9–21 秒）；
 *   ③ **不把 `comnet` 当靶子**：不点名任何项目、不写任何项目（`comnet` 正被并发写，与 git 差几百个节点）。
 *
 * 现状实现（oracle）是**照抄改动前那几行**的纯函数，**不是**产品代码 —— 产品代码只有一个实现
 * （`src/path-chain.js`）。两者对拍完，oracle 留在这里当"回退的证据"。
 * ⚠️ 本工具**不挂在 verify 链上**（与 `detail-census.js` / `recon-integration.js` 同一处置）：
 *   它的输入是**活的** `projects/**`，同一时刻工作区与 git HEAD 就是两个真值 ⇒ 它不许成为卡点。
 *
 * ## 「已裁决不纳入」那一半（2026-10-19 · 覆盖裁决批补的）
 * 「取证里逐条点名了、但去留没定」的 5 类字段（`items[].src` / `origin.src` / `links[]` /
 * `bindings[].dir` / `assoc[].members`）现在**逐类有终裁**：五条都是**不纳入**，理由各自不同。
 * 两条硬规矩：
 *   ① **终裁与理由的唯一权威是 `docs/ARCHITECTURE.md` §4b 的「逐类终裁」那张表** ——
 *      本脚本**不在代码里抄第二份**：运行时把那张表读出来**原样打印**；读不到就 exit **2**
 *      （"采不到真值"）并在报文里指名改哪儿。改 ADR 的理由 ⇒ 输出自动跟着变；两面不会漂。
 *   ② 那 5 类里的 `links[]` / `assoc[].members` **旧版根本没扫**（`collectPathFields` 里没有这两段）
 *      ⇒ 输出里的"0 条"读起来像"没有"，实际是"没看"。**沉默比差异更坏**（本工程反复治过的一类损害），
 *      本版起逐类**真的数出来**：`links[]` 与 `assoc` 成员按条计，且标注它们**连路径都不是**。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const chain = require('../src/path-chain.js');

const ROOT = path.resolve(__dirname, '..');

/* ================================================================
 * 一、现状实现（oracle）—— 逐字照抄改动前的产品代码，**只用于对拍**
 * ================================================================ */

/**
 * `renderer/app-media.js` 改动前的 `attachmentAbsPath(rel)`（逐字）：
 *   if (!state.project || !state.project.file) return null;
 *   const base = state.project.file.replace(/[\\/][^\\/]+$/, '');
 *   return base + '/' + rel.split('/').join('/');
 */
function legacyAttachmentAbs(project, rel) {
  if (!project || !project.file) return null;
  const base = project.file.replace(/[\\/][^\\/]+$/, '');
  return base + '/' + rel.split('/').join('/');
}

/** `renderer/app-detail-content.js` 改动前的图片地址（逐字）：`'../projects/' + name + '/' + img.file` */
function legacyImageUrl(project, file) {
  return project ? ('../projects/' + project.name + '/' + file) : file;
}

/** 改动前"这个附件点下去能不能开"：判据就是"项目路径在不在"（其余一概不判） */
function legacyAttachment(project, rel) {
  const abs = legacyAttachmentAbs(project, rel);
  if (abs === null) return { ok: false, abs: null, action: 'reject', why: '无项目路径（改动前同样打不开）' };
  const name = String(rel).split('/').pop();
  const ext = name.split('.').pop().toLowerCase();
  const action = (ext === 'md' || ext === 'markdown' || ext === 'pdf') ? 'preview' : 'system';
  return { ok: true, abs: abs, action: action, why: '' };
}

/** 改动前图片区：一行字符串拼接，永远渲染 `<img>`（坏了就是一颗静默裂图） */
function legacyImage(project, file) {
  return { ok: true, abs: legacyImageUrl(project, file), action: 'preview', why: '改动前一律渲染' };
}

/** 改动前 `localPath`：详情框/预览头只在"非空"时出现链接，点击原样交 `app:open-file` */
function legacyLocalPath(p) {
  if (!p || typeof p !== 'string' || !p.trim()) return { ok: false, abs: null, action: 'reject', why: '空值：改动前不渲染链接' };
  return { ok: true, abs: p, action: 'system', why: '' };
}

/* ================================================================
 * 二、语料：逐个项目、逐条路径类字段（**一次遍历出两份**）
 * ================================================================ */

/** 字段点名清单（**"哪些字段算路径类"的唯一清单**）。
 *  `consumed: true`  = **在打开链上** ⇒ 喂两套判据、比差异；
 *  `consumed: false` = **已裁决不纳入** ⇒ **只数条数、绝不判**（判它等于给一个没有消费者的面新增一条判据）；
 *  `pathShaped: false` = 它**连路径都不是**（`links[]` 的 `{project,id}`、`assoc[].members` 的节点 id）。 */
const FIELD_CLASSES = [
  { id: 'files[].file', consumed: true, pathShaped: true, note: '附件：md/pdf 内预览，其余交系统（renderer/app-media.js）' },
  { id: 'images[].file', consumed: true, pathShaped: true, note: '图片：详情框 <img> + 灯箱（renderer/app-detail-content.js）' },
  { id: 'localPath', consumed: true, pathShaped: true, note: '本机文件夹：详情框链接 / 右键菜单 / 预览头 → app:open-file' },
  { id: 'items[].src', consumed: false, pathShaped: true, note: '条目"出处"（file:line / URL）—— 由 src/item-src.js 解析；渲染层只当**文本**显示（无打开入口）' },
  { id: 'origin.src', consumed: false, pathShaped: true, note: '来源指纹的源文件/URL —— 只做导入幂等比对' },
  { id: 'links[]', consumed: false, pathShaped: false, note: '{project, id, caption}：站内标识，走 switchProject（**不是路径**）' },
  { id: 'bindings[].dir', consumed: false, pathShaped: true, note: '工作区绑定目录 —— 消费方是 CLI bind-sync（成组读写），不是"点开一个目标"' },
  { id: 'assoc[].members', consumed: false, pathShaped: false, note: '节点 id 集合（**不是路径**）；打开那篇笔记走浮窗，与文件打开无关' }
];

/** 已裁决不纳入的 5 类（= 上面 `consumed:false` 的那 5 条）。理由**不在本文件里**，从 ADR 表原样读。 */
const ADJUDICATED_IDS = FIELD_CLASSES.filter((f) => !f.consumed).map((f) => f.id);

/** 其中**连路径都不是**的两类（打印时单独标出：塞进路径判据 = 把不是路径的东西当路径判） */
const NON_PATH_IDS = ['links[]', 'assoc[].members'];

/** 终裁与理由的**唯一权威**：`docs/ARCHITECTURE.md` 里标题含这个锚的那张引用块表 */
const ADR_FILE = path.join(ROOT, 'docs', 'ARCHITECTURE.md');
const ADR_ANCHOR = '逐类终裁';

/**
 * 一次遍历，产出两份：
 *   ① `entries`     —— 路径类条目（喂两套判据：在链上 3 类 + 是路径但裁决不纳入的 3 类）；
 *   ② `adjudicated` —— **已裁决不纳入**的 5 类**计数**（只数，**不判**）。
 * `sub` 是几个**分量读数**（只为让"它不是路径"这件事可核）：`links[].project` / `.id` 各几条、
 * assoc 有几个条目、`items[].src` 有几条走的是**数组形态**。
 */
function collectFields(data) {
  const entries = [];
  const adjudicated = {};
  ADJUDICATED_IDS.forEach((id) => { adjudicated[id] = 0; });
  const sub = { linksProject: 0, linksId: 0, assocEntries: 0, itemsSrcArrayForm: 0 };
  const bump = (id) => { adjudicated[id] = (adjudicated[id] || 0) + 1; };

  const walk = (node, where) => {
    if (!node || typeof node !== 'object') return;
    const at = where || 'root';
    (node.files || []).forEach((f, i) => {
      if (f && typeof f.file === 'string') pushEntry(entries, 'files[].file', f.file, at + '.files[' + i + '].file', 'attachment');
    });
    (node.images || []).forEach((im, i) => {
      if (im && typeof im.file === 'string') pushEntry(entries, 'images[].file', im.file, at + '.images[' + i + '].file', 'image');
    });
    if (typeof node.localPath === 'string') pushEntry(entries, 'localPath', node.localPath, at + '.localPath', 'localPath');
    (node.items || []).forEach((it, i) => {
      if (!it || typeof it !== 'object') return;
      const at2 = at + '.items[' + i + '].src';
      /* `src` 是 `string | string[]`（见 `src/item-src.js` 的 `normalizeSrc`）⇒ **数组形态必须逐个数**：
       * 旧版只认 `typeof === 'string'`，一条带 3 个出处的条目会被数成 0（"没看"冒充"没有"）。 */
      if (typeof it.src === 'string') {
        pushEntry(entries, 'items[].src', it.src, at2, null);
        bump('items[].src');
      } else if (Array.isArray(it.src)) {
        sub.itemsSrcArrayForm += 1;
        it.src.forEach((s, j) => {
          if (typeof s === 'string' && s.trim()) {
            pushEntry(entries, 'items[].src', s, at2 + '[' + j + ']', null);
            bump('items[].src');
          }
        });
      }
    });
    if (node.origin && typeof node.origin.src === 'string') {
      pushEntry(entries, 'origin.src', node.origin.src, at + '.origin.src', null);
      bump('origin.src');
    }
    (node.links || []).forEach((l) => {
      if (!l || typeof l !== 'object') return;
      bump('links[]');
      if (typeof l.project === 'string' && l.project) sub.linksProject += 1;
      if (typeof l.id === 'string' && l.id) sub.linksId += 1;
    });
    (node.children || []).forEach((c, i) => walk(c, at + '.children[' + i + ']'));
  };
  walk(data && data.data, 'data');
  // 项目级字段（不在节点树上）
  (data && data.bindings || []).forEach((b, i) => {
    if (b && typeof b.dir === 'string') {
      pushEntry(entries, 'bindings[].dir', b.dir, 'bindings[' + i + '].dir', null);
      bump('bindings[].dir');
    }
  });
  (data && data.assoc || []).forEach((a) => {
    if (!a || !Array.isArray(a.members)) return;
    sub.assocEntries += 1;
    a.members.forEach(() => bump('assoc[].members'));
  });
  return { entries: entries, adjudicated: adjudicated, sub: sub };
}

function pushEntry(list, classId, raw, jsonPath, kind) {
  list.push({ classId: classId, raw: raw, jsonPath: jsonPath, kind: kind });
}

/** 兼容旧导出：只要路径类条目（`entries` 那一半） */
function collectPathFields(data) { return collectFields(data).entries; }

/* ================================================================
 * 二·六、已裁决不纳入的**理由**从哪来（唯一权威 = `docs/ARCHITECTURE.md` 那张表）
 * ------------------------------------------------------------
 * 为什么不把理由抄进本脚本：抄一份必然漂（本工程的老病），而那张表是 ADR 正文、由人写给人看。
 * ⇒ 运行时读出来**原样打印**；读不到就 **exit 2**（"采不到真值"），报文指名要改哪儿。
 * 表行形状（ADR §4b）：`> | \`字段\` | **裁决** | 理由 |` —— 只认这一种，别的行忽略。
 * ================================================================ */
function readAdrVerdicts() {
  const out = { file: 'docs/ARCHITECTURE.md', anchor: ADR_ANCHOR, found: false, rows: {}, missing: [], error: '' };
  let txt = '';
  try {
    txt = fs.readFileSync(ADR_FILE, 'utf8');
  } catch (e) {
    out.error = '读不到 ' + ADR_FILE + '（' + ((e && e.message) || e) + '）';
    out.missing = ADJUDICATED_IDS.slice();
    return out;
  }
  const lines = txt.split(/\r?\n/);
  const start = lines.findIndex((ln) => ln.indexOf(ADR_ANCHOR) >= 0);
  if (start < 0) {
    out.error = 'ADR 里找不到含「' + ADR_ANCHOR + '」的标题行（那张表被改名或删了？）';
    out.missing = ADJUDICATED_IDS.slice();
    return out;
  }
  for (let i = start; i < lines.length; i += 1) {
    const ln = lines[i];
    if (ln.indexOf('>') !== 0) break;                 // 引用块（那张表所在）结束
    const m = /^>\s*\|\s*`([^`]+)`\s*\|\s*\*\*([^*]+)\*\*\s*\|\s*(.*?)\s*\|\s*$/.exec(ln);
    if (m) out.rows[m[1]] = { verdict: m[2], reason: m[3] };
  }
  out.missing = ADJUDICATED_IDS.filter((id) => !out.rows[id]);
  out.found = out.missing.length === 0;
  if (!out.found) out.error = 'ADR 的「' + ADR_ANCHOR + '」表里缺这几类：' + out.missing.join(' · ');
  return out;
}

/** 读一个项目目录里的项目 JSON（`<目录>/<目录名>.json`，跳过点文件） */
function readProject(dirName) {
  const dir = path.join(ROOT, 'projects', dirName);
  const named = path.join(dir, dirName + '.json');
  const file = fs.existsSync(named)
    ? named
    : (fs.readdirSync(dir).filter((n) => /\.json$/i.test(n) && n[0] !== '.')[0] || '');
  if (!file) return { name: dirName, file: null, data: null, error: '目录里没有项目 JSON' };
  try {
    return { name: dirName, file: file, data: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')), error: '' };
  } catch (e) {
    return { name: dirName, file: file, data: null, error: 'JSON 解析失败：' + ((e && e.message) || e) };
  }
}

/* ================================================================
 * 二·五、合成边界样本（**不来自数据**）：把"形状"这一维压住
 * ------------------------------------------------------------
 * 真实语料只有十几条附件/图片（`files[].file` 实测只有个位数），
 * ⇒ 光靠它压不住"中文 / 空格 / 元字符 / `..` / UNC / 设备路径"这些形状。
 * 每条**写明期望**：`expectNew` = 新判据的结论；`expectDiff` = 是否**有意**与现状不同
 * （新判据更严的那几条就是这条链存在的理由，必须是"有意的差异"而不是"未预期的回退"）。
 * ================================================================ */
const SYNTHETIC_PROJECT = { file: 'D:\\zz-synth\\projects\\demo\\demo.json', name: 'demo' };
/* 格式：[kind, raw, 期望新判据, 是否有意与现状不同, 说明] */
const SYNTHETIC = [
  ['attachment', 'attachments/20261016 中文 附件 (1).pdf', 'ok', false, '中文 + 空格 + 括号（真实附件形态）'],
  ['attachment', 'attachments/a+b#c%20d.md', 'ok', false, 'URL 元字符：md 走内预览'],
  ['attachment', 'attachments/deep/子目录/x.zip', 'ok', false, '多级相对路径：zip 交系统'],
  ['attachment', 'attachments\\反斜杠\\sep.txt', 'ok', false, '反斜杠分隔（Node 两种都吃，改动前也能开）'],
  ['attachment', 'attachments/../../config.json', 'reject', true, '**.. 逃逸** ⇒ 新判据拦下（改动前会开出项目外）'],
  ['attachment', '../../../../Windows/win.ini', 'reject', true, '**.. 逃逸到盘根之外**'],
  ['attachment', '\\\\?\\C:\\Windows\\win.ini', 'reject', true, '**设备路径** \\\\?\\'],
  ['attachment', '\\\\.\\PhysicalDrive0', 'reject', true, '**设备路径** \\\\.\\'],
  ['attachment', '\\\\NAS\\share\\x.pdf', 'reject', true, '**UNC** 共享'],
  ['attachment', 'C:/Windows/win.ini', 'reject', true, '绝对路径当附件'],
  ['attachment', '/etc/passwd', 'reject', true, '前导斜杠'],
  ['attachment', '', 'reject', true, '空串'],
  ['image', 'assets/图 1.png', 'ok', false, '图片：中文 + 空格'],
  ['image', 'assets/../../comnet.json', 'reject', true, '**图片路径逃逸**'],
  ['image', 'assets/mumuhh47xthf.png', 'ok', false, '真实项目里那种随机名'],
  ['localPath', 'E:\\markdown\\M1', 'ok', false, '**localPath 的正常形态**：工作区外绝对路径（不许拿"在项目内"卡它）'],
  ['localPath', 'D:\\随便\\一个 目录（中文）', 'ok', false, 'localPath：中文 + 全角括号 + 空格'],
  ['localPath', '\\\\?\\E:\\markdown', 'reject', true, '**设备路径**'],
  ['localPath', '\\\\NAS\\share\\资料', 'reject', true, '**UNC 共享**（改动前能开 ⇒ 新判据更严，报告里点名）'],
  ['localPath', 'markdown/M1', 'reject', true, '不是**绝对**路径'],
  ['localPath', 'assets/..', 'reject', true, '相对形态（`localPath` 的契约是绝对路径）'],
  ['localPath', 'E:\\markdown\\' + 'x'.repeat(600), 'reject', true, '超过 500 字符（DATA-FORMAT §2.1 的上限）']
];

function runSynthetic() {
  const rows = SYNTHETIC.map((c) => {
    const kind = c[0]; const raw = c[1]; const expectNew = c[2]; const expectDiff = c[3]; const note = c[4];
    let legacy;
    if (kind === 'attachment') legacy = legacyAttachment(SYNTHETIC_PROJECT, raw);
    else if (kind === 'image') legacy = legacyImage(SYNTHETIC_PROJECT, raw);
    else legacy = legacyLocalPath(raw);
    const fresh = chain.decide({ kind: kind, raw: raw, project: SYNTHETIC_PROJECT });
    const diff = legacy.ok !== fresh.ok;
    return {
      kind: kind, raw: raw, note: note,
      legacyOk: legacy.ok, freshOk: fresh.ok, freshCode: fresh.code, freshReason: fresh.reason,
      diff: diff, expectNew: expectNew, expectDiff: expectDiff,
      pass: ((fresh.ok ? 'ok' : 'reject') === expectNew) && (diff === expectDiff)
    };
  });
  return {
    rows: rows,
    total: rows.length,
    failed: rows.filter((r) => !r.pass).length,
    expectedSame: rows.filter((r) => !r.expectDiff).length,
    expectedTighter: rows.filter((r) => r.expectDiff).length
  };
}

/* ================================================================
 * 三、对拍
 * ================================================================ */

/** 一条记录：新判据 × 现状实现 */
function judgeOne(entry, project) {
  const proj = project ? { file: project.file, name: project.name } : null;
  let legacy;
  if (entry.classId === 'files[].file') legacy = legacyAttachment(proj, entry.raw);
  else if (entry.classId === 'images[].file') legacy = legacyImage(proj, entry.raw);
  else if (entry.classId === 'localPath') legacy = legacyLocalPath(entry.raw);
  else legacy = { ok: null, abs: null, action: null, why: '不在打开链上（本批不消费）' };

  const fresh = entry.kind
    ? chain.decide({ kind: entry.kind, raw: entry.raw, project: proj })
    : { ok: null, abs: null, action: null, code: '', reason: '' };

  return {
    classId: entry.classId,
    jsonPath: entry.jsonPath,
    raw: entry.raw,
    legacy: legacy,
    fresh: fresh,
    sameOk: legacy.ok === fresh.ok,
    // 产物对拍：附件/localPath 比绝对路径；图片比**页面相对地址**（`<img src>` 用的就是它 ——
    // 拿它去比 `abs` 是把两种形态混在一起，是量具的错，不是产品的差异）
    freshArtifact: (entry.kind === 'image' && fresh.ok) ? chain.rendererUrlOf(proj, entry.raw) : fresh.abs,
    sameArtifact: (legacy.ok && fresh.ok)
      ? (legacy.abs === ((entry.kind === 'image') ? chain.rendererUrlOf(proj, entry.raw) : fresh.abs))
      : null,
    sameAction: (legacy.ok && fresh.ok) ? (legacy.action === fresh.action) : null
  };
}

function run(opts) {
  const o = opts || {};
  const dirs = fs.readdirSync(path.join(ROOT, 'projects'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name[0] !== '.')
    .map((e) => e.name)
    .filter((n) => !o.project || n === o.project)
    .sort();

  const report = {
    at: new Date().toISOString(),
    readOnly: true,
    projectsDir: 'projects/',
    projects: [],
    fieldClasses: FIELD_CLASSES,
    totals: { projectsScanned: 0, projectsFailed: 0, entries: 0, uniques: 0, consumed: 0, notConsumed: 0 },
    /* 「已裁决不纳入」那一半：**理由从 ADR 原样读**（`readAdrVerdicts`），条数是**实测**的。
     * `entries` = 5 类合计处数；`nonPath` = 其中连路径都不是的那两类（`links[]` / `assoc` 成员）。 */
    adjudicatedOut: {
      ids: ADJUDICATED_IDS, nonPathIds: NON_PATH_IDS,
      perClass: {}, sub: { linksProject: 0, linksId: 0, assocEntries: 0, itemsSrcArrayForm: 0 },
      entries: 0, nonPath: 0, adr: null
    },
    byClass: {},
    legacyAccept: 0,
    freshAccept: 0,
    diffs: [],
    absMismatch: [],
    synthetic: null,
    lines: []
  };
  ADJUDICATED_IDS.forEach((id) => { report.adjudicatedOut.perClass[id] = 0; });
  report.adjudicatedOut.adr = readAdrVerdicts();

  for (const dir of dirs) {
    const p = readProject(dir);
    if (p.error) {
      report.projects.push({ name: dir, file: p.file, counts: {}, error: p.error });
      report.totals.projectsFailed += 1;
      report.lines.push('  ✗ ' + dir + '：' + p.error);
      continue;
    }
    const fields = collectFields(p.data);
    const entries = fields.entries;                       // ① 路径类条目（喂判据）
    const consumed = entries.filter((e) => !!e.kind);     // ② 在打开链上（有 kind 才判）
    report.totals.projectsScanned += 1;
    report.totals.entries += entries.length;
    report.totals.consumed += consumed.length;
    report.totals.notConsumed += entries.length - consumed.length;
    ADJUDICATED_IDS.forEach((id) => {
      const n = fields.adjudicated[id] || 0;
      report.adjudicatedOut.perClass[id] += n;
      if (NON_PATH_IDS.indexOf(id) >= 0) report.adjudicatedOut.nonPath += n;
      report.adjudicatedOut.entries += n;
    });
    Object.keys(fields.sub).forEach((k) => { report.adjudicatedOut.sub[k] += fields.sub[k]; });
    const counts = {};
    consumed.forEach((e) => { counts[e.classId] = (counts[e.classId] || 0) + 1; });
    report.projects.push({ name: dir, file: p.file, counts: counts, error: '' });

    for (const e of entries) {
      const r = judgeOne(e, p);
      const cls = report.byClass[r.classId] || (report.byClass[r.classId] = {
        id: r.classId, consumed: !!e.kind, entries: 0, legacyAccept: 0, freshAccept: 0, diffs: 0, absMismatch: 0
      });
      cls.entries += 1;
      if (r.legacy.ok === true) { cls.legacyAccept += 1; report.legacyAccept += 1; }
      if (r.fresh.ok === true) { cls.freshAccept += 1; report.freshAccept += 1; }
      if (r.sameOk === false) {
        cls.diffs += 1;
        report.diffs.push({
          project: p.name, jsonPath: r.jsonPath, raw: r.raw, classId: r.classId,
          legacy: { ok: r.legacy.ok, action: r.legacy.action, why: r.legacy.why },
          fresh: { ok: r.fresh.ok, action: r.fresh.action, code: r.fresh.code, reason: r.fresh.reason }
        });
      } else if (r.sameArtifact === false || r.sameAction === false) {
        cls.absMismatch += 1;
        report.absMismatch.push({
          project: p.name, jsonPath: r.jsonPath, raw: r.raw, classId: r.classId,
          kind: r.sameArtifact === false ? '产物（abs / 页面相对地址）不同' : 'action 不同',
          legacy: { abs: r.legacy.abs, action: r.legacy.action },
          fresh: { abs: r.freshArtifact, action: r.fresh.action }
        });
      }
    }
  }

  // 去重读数（同一条路径在多个节点里重复出现时，差异只需看一次）
  const seen = {};
  let uniq = 0;
  for (const d of report.diffs) {
    const k = d.classId + '\u0000' + d.raw;
    if (seen[k]) continue;
    seen[k] = 1; uniq += 1;
  }
  report.totals.uniques = uniq;
  report.synthetic = runSynthetic();
  return report;
}

/* ================================================================
 * 四、输出
 * ================================================================ */

function main() {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') opts.json = true;
    else if (argv[i] === '--project') { opts.project = argv[i + 1]; i += 1; }
  }
  let report;
  try {
    report = run(opts);
  } catch (e) {
    console.error('✗ 采不到真值：' + ((e && e.message) || e));
    process.exit(2);
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('全量对拍：路径判据（src/path-chain.js）× 现状实现（改动前那几行）');
    console.log('  ⚠️ 只读：projects/*/*.json 一个字节都不写；两套判据都不做存在性探测');
    const ao = report.adjudicatedOut;
    console.log('  项目 ' + report.totals.projectsScanned + ' 个（读不到 ' + report.totals.projectsFailed + ' 个）'
      + ' · 路径类字段 ' + report.totals.entries + ' 条'
      + '（**在打开链上** ' + report.totals.consumed + ' 条 · 是路径但**已裁决不纳入** ' + report.totals.notConsumed + ' 条）');
    console.log('  另：**已裁决不纳入**的 5 类合计 ' + ao.entries + ' 处，其中**连路径都不是**的 ' + ao.nonPath + ' 处'
      + '（`links[]` ' + ao.perClass['links[]'] + ' · `assoc[].members` ' + ao.perClass['assoc[].members'] + '）'
      + ' —— 这两类**上一版根本没扫**（那时输出"0 条"= 没看，不是没有；本版起如实数出来）');
    console.log('');
    console.log('  ① **在打开链上**的三类（"能不能打开"的真读数；差异必须 = 0）：');
    console.log('    类别'.padEnd(20) + '条数'.padStart(7) + '现状accept'.padStart(12) + '新判据accept'.padStart(14) + '差异'.padStart(6));
    for (const f of FIELD_CLASSES) {
      if (!f.consumed) continue;
      const c = report.byClass[f.id] || { entries: 0, legacyAccept: 0, freshAccept: 0, diffs: 0 };
      console.log('    ' + f.id.padEnd(18) + String(c.entries).padStart(7) + String(c.legacyAccept).padStart(12)
        + String(c.freshAccept).padStart(14) + String(c.diffs).padStart(6));
    }
    console.log('');
    console.log('  ② **已裁决不纳入**的 5 类（行首是**实测条数**，理由按 ADR 原文打印）：');
    console.log('     终裁与理由的**唯一权威 = docs/ARCHITECTURE.md §4b 的「' + ADR_ANCHOR + '」表** ——');
    console.log('     本工具运行时读那一张表、**原样打印**，不在代码里抄第二份（两处不会漂）。');
    ADJUDICATED_IDS.forEach((id) => {
      const row = ao.adr && ao.adr.rows ? ao.adr.rows[id] : null;
      const n = ao.perClass[id] || 0;
      const tag = NON_PATH_IDS.indexOf(id) >= 0 ? '［不是路径］' : '［是路径、不是被打开的对象］';
      const extra = (id === 'assoc[].members') ? ('（' + ao.sub.assocEntries + ' 个 assoc 条目）') : '';
      console.log('    · ' + id.padEnd(18) + String(n).padStart(5) + ' 处' + extra + '  ' + tag
        + ' **不纳入** — ' + (row ? row.reason : '（ADR 里读不到 —— 见下面的「ADR 同步」行）'));
    });
    if (ao.adr && ao.adr.found) {
      console.log('    ✓ ADR 同步：' + ADJUDICATED_IDS.length + '/' + ADJUDICATED_IDS.length
        + ' 类在 `' + (ao.adr.anchor) + '` 表里逐条找到（读到 ' + Object.keys(ao.adr.rows).length + ' 行）'
        + ' —— 改那张表的理由，本段输出**自动**跟着变');
    } else {
      console.log('    ✗ ADR 同步：' + ((ao.adr && ao.adr.error) || '读不到那张表'));
      console.log('      ⇒ 这是**采不到真值**（"已裁决不纳入 + 理由"这一节没有权威可引），不是"没有不纳入的类"');
      console.log('      ⇒ 修法：把 `docs/ARCHITECTURE.md` §4b 的「' + ADR_ANCHOR + '」表补齐（每类一行 `| `字段` | **不纳入** | 理由 |`）');
    }
    console.log('');
    if (ao.sub.itemsSrcArrayForm || ao.sub.linksProject || ao.sub.assocEntries) {
      console.log('    分量读数（用来核"它不是路径"这件事，不参与判据）：'
        + '`links[].project` ' + ao.sub.linksProject + ' 条 · `links[].id` ' + ao.sub.linksId + ' 条'
        + ' · assoc 条目 ' + ao.sub.assocEntries + ' 个 · `items[].src` 数组形态的条目 ' + ao.sub.itemsSrcArrayForm + ' 条');
      console.log('');
    }
    console.log('  合计：现状 accept ' + report.legacyAccept + ' 条 · 新判据 accept ' + report.freshAccept + ' 条');
    console.log('  差异（ok 不同）：' + report.diffs.length + ' 条（去重后 ' + report.totals.uniques + ' 个不同的路径）');
    report.diffs.forEach((d) => {
      console.log('    ✗ [' + d.project + '] ' + d.classId + ' ' + d.jsonPath);
      console.log('        路径 = ' + JSON.stringify(d.raw));
      console.log('        现状：ok=' + d.legacy.ok + ' action=' + d.legacy.action + (d.legacy.why ? '（' + d.legacy.why + '）' : ''));
      console.log('        新判据：ok=' + d.fresh.ok + ' action=' + d.fresh.action + ' code=' + d.fresh.code + ' reason=' + d.fresh.reason);
    });
    if (report.absMismatch.length) {
      console.log('  ⚠️ ok 相同但产物不同（abs / 页面相对地址 / action）：' + report.absMismatch.length + ' 条 —— 这条也要当差异看待');
      report.absMismatch.slice(0, 30).forEach((d) => {
        console.log('    · [' + d.project + '] ' + d.classId + ' ' + d.jsonPath + ' ' + d.kind
          + '\n        现状：' + JSON.stringify(d.legacy) + '\n        新判据：' + JSON.stringify(d.fresh));
      });
    } else {
      console.log('  ✓ ok 相同的条目里，产物（abs / 页面相对地址）与 action **逐条相同**（默认档产物不变）');
    }
    console.log('');
    const sy = report.synthetic;
    console.log('  合成边界样本（**不来自数据**，压"形状"这一维）：' + sy.total + ' 条'
      + '（预期与现状相同 ' + sy.expectedSame + ' 条 · 预期**新判据更严** ' + sy.expectedTighter + ' 条）');
    sy.rows.forEach((r) => {
      console.log('    ' + (r.pass ? '✓' : '✗') + ' ' + r.kind.padEnd(11) + JSON.stringify(r.raw).slice(0, 46).padEnd(48)
        + ' 现状=' + (r.legacyOk ? 'accept' : 'reject').padEnd(7) + ' 新=' + (r.freshOk ? 'accept' : 'reject').padEnd(7)
        + (r.diff ? '（有意更严）' : '') + ' ' + r.note);
      if (!r.pass) console.log('         ✗ 与期望不符：期望新判据=' + r.expectNew + ' 期望差异=' + r.expectDiff
        + ' 实际 code=' + r.freshCode + ' reason=' + r.freshReason);
    });
    console.log('');
    if (report.totals.projectsFailed) {
      console.log('✗ 有项目读不到 ⇒ 采不到真值（按门禁口径：采不到真值 = 红，不许当成"没差异"）');
      process.exit(2);
    }
    if (!report.adjudicatedOut.adr || !report.adjudicatedOut.adr.found) {
      console.log('✗ 「已裁决不纳入 + 理由」这一节没有权威可引 ⇒ **采不到真值**（不是"没有不纳入的类"）');
      process.exit(2);
    }
    if (sy.failed) {
      console.log('✗ 合成样本有 ' + sy.failed + ' 条与期望不符 ⇒ 判据的形状面被改动过了，先定性再谈别的');
      process.exit(1);
    }
    if (report.diffs.length || report.absMismatch.length) {
      console.log('✗ 差异 ≠ 0 ⇒ **不许上线**（先逐条定性：旧实现错了 / 新判据错了 / 两者都有理）');
      process.exit(1);
    }
    console.log('✓ 真实语料差异 0 —— 新判据与现状实现逐条等价（ok / 产物 / action 三项全等）；'
      + '合成样本 ' + sy.total + ' 条全部符合期望（其中 ' + sy.expectedTighter + ' 条是**有意的更严**）');
  }
  process.exit(0);
}

if (require.main === module) main();
module.exports = {
  run, runSynthetic, judgeOne, SYNTHETIC, SYNTHETIC_PROJECT,
  legacyAttachment, legacyImage, legacyLocalPath, legacyAttachmentAbs, legacyImageUrl,
  collectFields, collectPathFields, FIELD_CLASSES,
  // 「已裁决不纳入」那一半（理由从 ADR 读，条数是实测的）
  ADJUDICATED_IDS, NON_PATH_IDS, ADR_ANCHOR, readAdrVerdicts
};
