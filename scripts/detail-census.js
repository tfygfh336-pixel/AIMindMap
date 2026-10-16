#!/usr/bin/env node
/* ============================================================
 * scripts/detail-census.js — **detail 语料的现算读数**（只读，非门禁）
 * ------------------------------------------------------------
 * 一句话：回答"**现在**有几个项目 / 几个节点 / 几个含 detail 的节点 / 几个含白名单标签的 detail"，
 * 并把**白名单标签正则**与实现同源（`src/convert.js` 的 `stripHtml` 同族的那套标签名）。
 *
 * ## 为什么需要它（这是本脚本存在的唯一理由）
 *
 * `R7` 设计稿与它带出的几处工程文档**一度写死了同一批语料数字**
 * （"`comnet` 133 个含 detail 节点"、"`comnet` 47 条链接全是死链"）。这些数字：
 *   ① **本来就不对**（实测 450/753、119 —— 见 `.review/20261016-R7设计核查/` 的 48 条核查记录）；
 *   ② 更根本的是**它们会一直变**（`comnet` 正在被并发会话写入：工作区 889 节点 vs git HEAD 551 节点，
 *      同一份文件同一时刻两个真值）。
 * ⇒ 结论：这类读数**不许写进文档正文**，只许写"**跑这个脚本打印出来的那个数**"。
 * 本工程已经在别处踩过同一形态（`docs/ARCHITECTURE.md` 的 CLI 稳定性表、`docs/VERIFY.md` 的计数）
 * —— 处置一律是**现算 + 单一来源**，不是"再抄一份更准的"。
 *
 * ## 口径（每个都要能独立复算，缺一不可）
 *
 * - **节点**：`data` 是**根节点对象**（不是数组），递归走 `children`；根节点**计入**。
 * - **含 detail**：`node.detail` 去空白后非空。`detail` 为空串 / 缺失 / 只有空白 ⇒ 不算。
 * - **含白名单标签**：`detail` 里出现 `TAG_RE` 命中的标签。判据是"**含**"（不是"只含"），
 *   因为真语料里 `<p>` 文本里夹一段裸文本是常态；"100% 是 HTML"这条要判的是**有没有 HTML 结构**。
 * - **链接**：`node.links[]` 逐条数，`same` = `project` 缺省或等于本项目目录名（**同项目**），
 *   否则 `cross`；`item` = 带条目级 `item` 字段的条数。
 * - **`.visits` / `.writers`**：`projects/` 下的**非项目**目录（探针与批写登记），**跳过**
 *   （它们的"JSON"不是项目数据，混进来会把项目数算多）。
 *
 * ## 为什么"总数"口径与"项目数"都要打印
 *
 * 判据写"对某项目的 N 个节点逐个渲染"时，N 取错会**静默漏测**（照 133 实现 ⇒ 漏测 317~620 个）。
 * 所以本脚本**默认就打印每个项目的分布**，让"用哪个当靶子、靶子多大"当场可见 ——
 * 而不是给一个总数让人自己去猜分母。
 *
 * ## 用法
 *
 * ```
 * node scripts/detail-census.js                  # 全部项目 + 合计
 * node scripts/detail-census.js comnet           # 只看一个项目
 * node scripts/detail-census.js --json           # 机器可读（给脚本/断言取真值）
 * node scripts/detail-census.js --json comnet    # 单个项目的 JSON
 * ```
 *
 * 退出码：0 = 报出读数（**不管数字是多少** —— 试金石不是数字，是"读得准不准"）；
 *         2 = **采不到真值**（`projects/` 不存在 / 一个项目文件都读不出来）。
 *
 * ⚠️ **它是只读工具**：不写盘、不改项目数据、不进 `npm run verify` 的必跑集
 * （它是"取真值"的口径工具，不是判据；判据那边引用它打印的数）。
 * ============================================================ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(ROOT, 'projects');

/* ---------------- 白名单标签（与设计稿 §② 判定表的"允许"档同源） ----------------
 * ⚠️ **这是设计稿 §② 的判定表在"读数"这一侧的投影**，不是第二份白名单实现：
 *   真正的白名单校验属于 R7 主体的消毒模块（尚未落地）；本脚本只拿它当"这段 detail
 *   有没有 HTML 结构"的量具。R7 消毒模块落地后，**这份正则要改成从模块里取**
 *   （`require('../src/…')` 的那一族），否则就是同一件事的两处表达 ✗。 */
const WHITELIST_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'sub', 'sup', 'kbd', 'mark',
  'code', 'pre', 'blockquote', 'details', 'summary', 'a', 'img', 'div', 'span'
];
const TAG_RE = new RegExp('</?(?:' + WHITELIST_TAGS.join('|') + ')\\b', 'i');

/* ---------------- 读一个项目文件 ---------------- */

/** 递归收集节点（`data` 是根**对象**；根计入）。 */
function collectNodes(root, out) {
  out = out || [];
  if (!root || typeof root !== 'object') return out;
  out.push(root);
  const ch = root.children;
  if (Array.isArray(ch)) for (const c of ch) collectNodes(c, out);
  return out;
}

/** 单个项目文件的读数。`projectName` = 目录名（`links[].project` 缺省时按同项目算）。 */
function censusProjectFile(file, projectName) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nodes = collectNodes(j.data);
  let withDetail = 0, tagged = 0, untagged = 0;
  const untaggedSamples = [];
  for (const n of nodes) {
    const d = n && n.detail;
    if (typeof d !== 'string' || !d.trim()) continue;
    withDetail++;
    if (TAG_RE.test(d)) { tagged++; continue; }
    untagged++;
    /* 残样只留 5 条：它们**就是**"渲染期探测"那条规则的真值边界样本
     * （既不是 HTML 也不是空 —— 落到哪一支必须显式决定，不许让它默默走默认档）。 */
    if (untaggedSamples.length < 5) {
      untaggedSamples.push({ id: n.id, topic: String(n.topic || '').slice(0, 40), preview: d.slice(0, 60) });
    }
  }
  let links = 0, same = 0, cross = 0, linkItems = 0;
  for (const n of nodes) {
    const ls = n && n.links;
    if (!Array.isArray(ls)) continue;
    for (const l of ls) {
      if (!l || typeof l !== 'object') continue;
      links++;
      if (!l.project || String(l.project) === String(projectName)) same++;
      else cross++;
      if (l.item) linkItems++;
    }
  }
  return {
    project: projectName,
    nodes: nodes.length,
    withDetail: withDetail,
    tagged: tagged,
    untagged: untagged,
    untaggedSamples: untaggedSamples,
    links: links,
    linksSameProject: same,
    linksCrossProject: cross,
    linksWithItem: linkItems,
    assoc: Array.isArray(j.assoc) ? j.assoc.length : 0
  };
}

/** 扫 `projects/` 下**所有**项目（跳过 `.visits` / `.writers` 一类非项目目录）。 */
function censusAll(only) {
  let entries;
  try { entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); }
  catch (e) { return { error: 'projects/ 读不出来：' + e.message, rows: [] }; }
  const rows = [];
  const unreadable = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;                       // .visits / .writers（非项目）
    if (only && e.name !== only) continue;
    const f = path.join(PROJECTS_DIR, e.name, e.name + '.json');
    if (!fs.existsSync(f)) { unreadable.push(e.name); continue; }
    try { rows.push(censusProjectFile(f, e.name)); }
    catch (err) { unreadable.push(e.name + '(' + err.message + ')'); }
  }
  return { rows: rows, unreadable: unreadable };
}

function total(rows) {
  const t = {
    projects: rows.length, nodes: 0, withDetail: 0, tagged: 0, untagged: 0,
    links: 0, linksSameProject: 0, linksCrossProject: 0, linksWithItem: 0, assoc: 0
  };
  for (const r of rows) for (const k of Object.keys(t)) if (k !== 'projects') t[k] += r[k];
  return t;
}

/* ---------------- 打印 ---------------- */

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function lpad(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

function printHuman(res, only) {
  if (res.error) { console.error('✗ ' + res.error); return; }
  console.log('== detail 语料现算（只读；口径见本文件头）==');
  console.log(pad('项目', 24) + lpad('节点', 7) + lpad('含detail', 9) + lpad('含标签', 8)
    + lpad('不含', 6) + lpad('链接', 7) + lpad('同项目', 8) + lpad('跨项目', 8) + lpad('assoc', 7));
  for (const r of res.rows) {
    console.log(pad(r.project, 24) + lpad(r.nodes, 7) + lpad(r.withDetail, 9) + lpad(r.tagged, 8)
      + lpad(r.untagged, 6) + lpad(r.links, 7) + lpad(r.linksSameProject, 8)
      + lpad(r.linksCrossProject, 8) + lpad(r.assoc, 7));
  }
  if (!only) {
    const t = total(res.rows);
    console.log('-'.repeat(24 + 7 + 9 + 8 + 6 + 7 + 8 + 8 + 7));
    console.log(pad('合计（' + t.projects + ' 个项目）', 24) + lpad(t.nodes, 7) + lpad(t.withDetail, 9)
      + lpad(t.tagged, 8) + lpad(t.untagged, 6) + lpad(t.links, 7) + lpad(t.linksSameProject, 8)
      + lpad(t.linksCrossProject, 8) + lpad(t.assoc, 7));
  }
  for (const r of res.rows) {
    if (!r.untaggedSamples.length) continue;
    console.log('');
    console.log('· ' + r.project + ' 的 ' + r.untagged + ' 个"含 detail 但不含白名单标签"的样本'
      + '（**渲染期探测的真值边界** —— 落到哪一支必须显式决定）：');
    for (const s of r.untaggedSamples) {
      console.log('    ' + s.id + ' ｜ ' + s.topic + ' ｜ ' + JSON.stringify(s.preview));
    }
  }
  if (res.unreadable.length) console.log('\n⚠️ 跳过的目录/文件：' + res.unreadable.join(' · '));
  console.log('');
  console.log('引用方式（**不许把数字抄进文档**）：写"跑 node scripts/detail-census.js 打印的那个数"。');
}

/* ---------------- CLI ---------------- */

function main(argv) {
  const json = argv.includes('--json');
  const only = argv.find((a) => !a.startsWith('--')) || '';
  const res = censusAll(only || undefined);
  if (res.error) { console.error('✗ ' + res.error); return 2; }
  if (only && !res.rows.length) {
    console.error('✗ 找不到项目 "' + only + '"（projects/' + only + '/' + only + '.json 不存在）—— 采不到真值');
    return 2;
  }
  if (!res.rows.length) { console.error('✗ 一个项目文件都没读到 —— 采不到真值'); return 2; }
  if (json) {
    const payload = { only: only || null, rows: res.rows, unreadable: res.unreadable };
    if (!only) payload.total = total(res.rows);
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    printHuman(res, only);
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  WHITELIST_TAGS: WHITELIST_TAGS,
  TAG_RE: TAG_RE,
  collectNodes: collectNodes,
  censusProjectFile: censusProjectFile,
  censusAll: censusAll,
  total: total
};
