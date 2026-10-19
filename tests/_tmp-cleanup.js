/* ============================================================
 * tests/_tmp-cleanup.js —— 单测临时目录的**唯一**创建 + 收尾件
 * ------------------------------------------------------------
 * 为什么有这个文件（不是"为了少写几行"）：
 *
 * 形状在 `tests/` 里重复到了第 5 处 —— 每个文件都自己写一遍
 * `const TMPDIRS = []; const tmp = () => { mkdtemp; push; return }` + 一段 `afterAll` 逐个 `rmSync`。
 * 重复的那 15 行里有两条**不是风格、而是判据**的东西，每复制一次就有一次丢掉的危险：
 *
 *   ① **每一次创建都必须登记**。
 *      2026-10-19 实测的病：`tests/bindings.test.js` 的 `afterEach` 里明明有
 *      `rmSync(..., {recursive:true, force:true})`，看起来在收尾，**一次仍漏 21 个目录**（那是**当时**的用例数 ——
 *      该文件现为 28 用例 ⇒ 一次登记 **49** 个目录 = 28 × `beforeEach` + 21 × 用例体内；数字以实测为准，
 *      别把这个 21 当常量抄进别处）——
 *      因为它删的是 `TMP` 的**当前值**，而 `beforeEach` 与用例体**各建一个新目录**，
 *      前者从建出来起就再没人引用。同型的还有 `tests/control-poll.test.js`（一次漏 7 个）。
 *      ⇒ 结论：**"有清理代码" ≠ "清理覆盖了所有建出来的东西"**，而且**靠读代码分不开**。
 *      唯一可靠的形态是"创建即登记"，登记的入口只有这里一个。
 *
 *   ② `recursive + force` **是必须的**（更早 `550ed82` 的教训）。
 *      只调非递归的 `rmdirSync` 在**非空**目录上会 `ENOTEMPTY` ⇒ "有这条代码"≠"这条代码有能力做这件事"。
 *      本文件里的目录全是测试自己写的文件/子目录（`control/{pending,consuming,done}`、`notes/` …）⇒ 必然非空。
 *
 *   ③ 清理失败**响亮，但不判红**（两条必须同时成立）：
 *      · 静默 ⇒ 把"没做到"伪装成"做过"（`testing-for-ai` F 组）；所以失败时**逐条**打 `目录 :: code` 到 stderr；
 *      · 判红（throw）⇒ 本文件测的是别的东西，**收尾出问题不该连坐用例** —— 那种红会被读成"功能坏了"。
 *      可区分的读数：
 *        用例失败 = vitest 的 `FAIL / AssertionError` 报文；
 *        收尾失败 = stderr 的 `[tmp-cleanup] ⚠️ 清理失败 N / M 项`（可 grep）+ 残留目录**保留**以便排查；
 *        成功也打一行三态读数 —— 否则"清理到底跑没跑"在**绿的**运行里没有任何痕迹（这也是本条存在的理由）。
 *
 *   ④ 三态读数按 **prefix 分组**（`mm-control-test-：9/9`），不按文件分组：
 *      判据要对着 `%TEMP%` 的**增量**看，而 `%TEMP%` 里能分辨的就是 prefix。
 *      上一批各文件自己写死一句 `'[tmp-cleanup] bindings：…'`，那是**第四份会漂的字面量**（改了 prefix 它不跟着变）。
 *
 * ## 为什么用**模块级**登记表而不是每个文件各建一个
 * vitest 默认 `isolate: true`（本工程 `vitest.config.mjs` 没关它）⇒ **每个测试文件拿到独立的模块图**，
 * 本模块的单例天然是"每文件一份"。
 * 万一将来有人把 `isolate` 关了也不出错：登记表在 `cleanupAll()` 里**清空**，而同池内各文件是**顺序**执行的
 * ⇒ 后一个文件的 `afterAll` 看不到前一个文件的残留项，前一个文件的 `afterAll` 也不会删后一个文件刚建的目录。
 *
 * ## 用法（4 个测试文件都长这样）
 * ```js
 * import { afterAll } from 'vitest';
 * import { makeTmp, cleanupAll } from './_tmp-cleanup.js';
 *
 * const tmp = () => makeTmp('mm-control-test-');   // 每次创建都自动登记
 * afterAll(cleanupAll);                            // 收尾只此一处
 * ```
 * ⚠️ **不许**在文件里再写一份 `fs.rmSync` 的收尾（那就是第 5、第 6 处重复，且它删不到"没被引用的那一个"）。
 * ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 已创建的目录：`{ dir, prefix }[]`（**创建即登记**，本文件是唯一入口） */
const REGISTERED = [];

/**
 * 建一个临时目录并**登记**它。
 * @param {string} prefix 交目录名前缀（约定 `mm-<家族>-`），用于 `%TEMP%` 里认领归属
 * @returns {string} 目录绝对路径
 */
export function makeTmp(prefix) {
  if (typeof prefix !== 'string' || !prefix) {
    throw new TypeError('makeTmp(prefix)：prefix 必须是非空字符串（它决定 %TEMP% 里怎么认领这个家族）');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  REGISTERED.push({ dir: dir, prefix: prefix });
  return dir;
}

/** 只读快照：当前还登记着、尚未清理的目录（排查用；不要拿来当删除入口） */
export function tmpDirs() {
  return REGISTERED.map((r) => r.dir);
}

/**
 * 删除**所有**已登记的目录，打印三态读数。**永不抛异常**（清理失败不许连坐用例）。
 * 幂等：清空后登记表归零，再调一次就是 `创建 0 个`。
 * @returns {{total:number, removed:number, failed:number}} 读数（调用方若想断言可以拿，正常路径不需要）
 */
export function cleanupAll() {
  const total = REGISTERED.length;
  /** @type {string[]} */
  const failed = [];
  /** @type {Map<string, {total:number, removed:number}>} */
  const byPrefix = new Map();
  let removed = 0;

  for (const item of REGISTERED) {
    let ok = false;
    try {
      // recursive + force：目录必然非空（550ed82 的教训 —— 非递归 rmdirSync 在非空目录上 ENOTEMPTY）
      fs.rmSync(item.dir, { recursive: true, force: true });
      // rm 不抛但目录还在 = 另一种"删不掉"（不许记成删掉了）
      if (fs.existsSync(item.dir)) failed.push(item.dir + ' :: STILL_EXISTS');
      else ok = true;
    } catch (e) {
      failed.push(item.dir + ' :: ' + String((e && (e.code || e.message)) || e));
    }
    if (ok) removed += 1;
    const rec = byPrefix.get(item.prefix) || { total: 0, removed: 0 };
    rec.total += 1;
    if (ok) rec.removed += 1;
    byPrefix.set(item.prefix, rec);
  }

  REGISTERED.length = 0;   // 先清表再看读数：即使下面 console 抛了，也不会重复删

  const groups = Array.from(byPrefix.entries()).map(([p, r]) => p + '：' + r.removed + '/' + r.total);
  console.log('[tmp-cleanup] 创建 ' + total + ' 个 · 删掉 ' + removed + ' 个 · ⚠️ 删不掉 ' + failed.length
    + ' 个' + (groups.length ? '（' + groups.join(' · ') + '）' : ''));
  if (failed.length) {
    console.error('[tmp-cleanup] ⚠️ 清理失败 ' + failed.length + ' / ' + total
      + ' 项（残留目录**保留**以便排查；**不影响**本文件用例判定）：\n  - ' + failed.join('\n  - '));
  }
  return { total: total, removed: removed, failed: failed.length };
}
