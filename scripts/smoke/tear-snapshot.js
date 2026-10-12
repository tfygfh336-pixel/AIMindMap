/* ============================================================
 * scripts/smoke/tear-snapshot.js —— 冒烟「撕裂快照」诊断的判据（纯函数，可单测）
 * ------------------------------------------------------------
 * 它回答**一个问题**：把真实 `projects/` 拷成沙箱副本的**那一刻**，源目录是不是正被别的进程写
 * （拷到半截 ⇒ 副本里可能出现"引用指向不存在的节点" ⇒ 保存闸门拒 ⇒ 冒烟卡死）。
 *
 * 判据只有一条，但 **采样时机是判据的一部分**：两侧的 SHA1 必须在 `cpSync` 返回后的**同一刻**采。
 * 为什么（实测取证，2026-10-12）：
 *   · 沙箱副本在 `main.js` **模块加载期**就拷好了（那时应用还没起来）；而检查原先在
 *     `did-finish-load + 500ms`（`runSmoke` 里）才跑 ⇒ 两侧指纹相差 2~3 秒；
 *   · 这个窗口里，应用启动会把**自己的界面状态**落成 `projects/<项目>/.ui-state.json`
 *     （渲染层脏标记上报 → 主进程 `writeUiStateFile`），而 `PROJECTS_DIR` 在冒烟模式指向沙箱
 *     ⇒ 写的是副本。实测：`cpSync` 之后约 **0.8 秒**就写了一次，内容里带的是**本进程 pid**
 *     （`{"schemaVersion":1,"project":"comnet","dirty":false,"uiPid":<冒烟进程 pid>,"updatedAt":…}`），
 *     且 `updatedAt` 与该文件的 mtime 逐毫秒相同（= 不是拷贝来的，是**刚写的**）；
 *   · 于是那一行"不一致"读数是**副本自己的合法写入**，与撕裂快照无关 ✗。同一形态的旧证据：
 *     `.review/` 里 2026-10-09~10-10 的 16 份冒烟日志 —— 真实侧恒为 `2fcd4522fa2a`，
 *     副本侧 16 个各不相同的值（每次跑都变 = 写者带着当次进程的 pid 与时刻）。
 *
 * 结论：**比什么**不变（两侧同一个 `.json` 的 SHA1 前 12 位），**采样点**收到"拷贝刚完成那一刻"——
 * 这样"不一致"只可能是"源在拷贝期间/之前被写过"，正是这条诊断要抓的东西 ✓。
 *
 * 边界（诚实标注，别以为它能包住一切）：
 *   · 它是**事后比对**：抓得到"拷贝前后源发生了变化"，抓不到"源在拷贝**中途**被写、而拷完又恰好
 *     与终值相同"那种瞬时撕裂（要抓那种只能在读盘时加锁/校验，不在本诊断范围内）；
 *   · 只比 `.json`（与 `main.js` 原实现同一条规则）：图片/附件不是"引用完整性"的载体，
 *     纳入进来只会让读数变慢变吵 ✗；
 *   · 它**判不了**"副本后来被谁改过"——副本在开跑后本来就会被应用自己改（第一条 bullet），
 *     那是**预期行为**，不是泄漏：真实侧的复核由 `main.js` 的「真实数据零写入」那条负责 ✓。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 参与比对的只有 `.json`（与 `main.js` 原实现同一条规则，见头注的边界②）。 */
function isCompared(name) { return name.endsWith('.json'); }

/**
 * 递归收集一棵树里的 `.json`（相对路径，`/` 分隔）。目录不存在/读不出来 ⇒ 空数组（不抛）。
 * @param {string} dir 根目录
 * @returns {string[]} 相对路径（排序后，读数稳定）
 */
function collectJsonFiles(dir) {
  const out = [];
  const walk = (abs, base) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(abs, e.name);
      const rel = base ? base + '/' + e.name : e.name;
      if (e.isDirectory()) walk(p, rel);
      else if (isCompared(e.name)) out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

/** 文件内容的 SHA1 前 12 位；读不出来（不存在/没权限/是目录）⇒ `'?'`（与 `main.js` 原实现同一个哨兵值）。 */
function sha12(file) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12); }
  catch (e) { return '?'; }
}

/**
 * 比对**此刻**两侧的 `.json` 指纹。
 * @param {string} realDir 真实项目根
 * @param {string} copyDir 沙箱副本根（比较以**副本侧**收集到的那份清单为准）
 * @returns {{same:number, diff:number, only:number,
 *            diffs:Array<{rel:string,real:string,copy:string}>, files:string[]}}
 *   `only` = 副本里有、真实侧读不出来的那些（原实现里就是这个口径）。
 */
function compareTrees(realDir, copyDir) {
  const files = collectJsonFiles(copyDir);
  const res = { same: 0, diff: 0, only: 0, diffs: [], files: files };
  for (const rel of files) {
    const a = sha12(path.join(realDir, rel));
    const b = sha12(path.join(copyDir, rel));
    if (a === '?') { res.only++; continue; }
    if (a === b) res.same++;
    else { res.diff++; res.diffs.push({ rel: rel, real: a, copy: b }); }
  }
  return res;
}

module.exports = { collectJsonFiles, sha12, compareTrees, isCompared };
