/* ============================================================
 * tests/verify-budget.test.js — 验证链耗时预算与链定义自洽
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 为什么需要它：计时本身不可单测（依赖机器与负载），但**判定逻辑**可以，
 * 而判定逻辑写错会让这个门禁变成"永远通过"或"随机红灯" —— 两种都会让它被无视。
 *
 * 【批 J（2026-10-13）加】三件事，都是"把写下来的说法变成机械守卫"：
 *   · 两条结构性不变量从**注释**升级成**守卫**：① `main.js` 的冒烟守卫 > G5 预算；
 *     ② 合计预算 ≥ 各步预算之和（两条都**从代码现读**，不抄数字）；
 *   · "预算留足余量"那条的 `measured` 不再**写死**，改为现读 `.review/verify-history.jsonl`
 *     的真读数（写死过一次：表里还写着 G5≈51s，而真值早已是 235–421s ⇒ 它一直在守一个
 *     不存在的世界，绿着但什么都没守 ✗ 本工程最重的损害类别）。
 *   · 【2026-10-14 本批】**余量守卫的口径**从"窗口**最小**值 × 1.8"改成"窗口**最大**值 × 1.25"
 *     —— 旧口径由**最快的一天**决定、窗口一滚就假红（实测 250s 被挤出 ⇒ 最小值爬到 341.9s ⇒
 *     比值 1.579 ✗），而预算这条线防的是"太慢/挂死" ⇒ 基准该取**慢端**（理由详见 `recentMeasured`）。
 *     **只改口径、不动任何预算常量** ✓。
 *   · 【2026-10-18 本批】**再次只改口径**：`1.25 × 窗口最大` → `1.25 × 窗口 P90`（n=10 ⇒ 第 9 个值）。
 *     为什么必须换：上一版的基准是**最大值**，于是**一次负载尖峰会在窗口里赖满 10 次成功全链**，
 *     期间预算被永久抬高（实测：窗口 max = 1 174 160ms 那条已被证明是机器慢 —— 同一次 run 里
 *     G3 涨 1.267× / G4 涨 1.438×，而这两个步骤与冒烟域毫无关系 ⇒ 预算被抬到 1 468 000ms，
 *     比值只剩 **1.0002**，止涨线失去牙）。而**分层**把这放大：全量档从每天 ~10 次降到 ~1 次
 *     ⇒ 一条尖峰会赖 **~10 天**。换成 P90 后同样的 1.25 倍**只对慢端**生效，尖峰抬不动线。
 *     ⚠️ 代价与它为什么**不会掩盖真实慢化**，见下面 `P90 口径：为什么它比 max 稳、又不放过变慢` 一节
 *     —— 那一节同时有**结构判定**（`P90 不会掩盖「持续变慢」` 那条 it）钉住，不是只写在注释里。
 *   · 【2026-10-19 本批】**第三次只改口径（只改一次，就改到位）**：`1.25 × 窗口 P90` → `1.25 × 窗口 median`。
 *     为什么 P90 也不行：n=10 时 nearest-rank `P90 = 第 9 个值 = 第二大` ⇒ **只容忍 1 条尖峰**，
 *     第二条就翻红。上一批（`b73c7ae`）的反例检查原话正是"**只丢最大的那 1 条**" ——
 *     那句话**精确描述了缺陷**，当时被写成了优点（本批把它当作"别再犯"的样本）。
 *     当天有两次实测：一条尖峰把线从 1300 顶到 **1468**（比值 1.0002，止涨线没有牙）；
 *     又一次方差把线从 1300 顶到 **1350**（比值 1.2435）。⇒ 换 median，并把多付的 50s 还回去。
 *     ⚠️ **关于"两个方向都更好"这句话：实测只支持一半**（本批如实订正）：
 *     · 抗尖峰：**确实更好**（需 6 条读数才动，P90 只需 2 条）✓；
 *     · 发现持续变慢：**比 P90 更慢，不是更快** ✗ —— 构造上 median 要 **6 条**读数进入新高度才抬，
 *       P90 只要 **2 条**；历史 6 处长台阶上实测滞后中位 **8.5 条**读数（P90 1.5 条）。
 *     ⇒ 这是一次**取舍**而不是净改进。选 median 这一侧的理由见下面 `median 口径` 一节 ②（有界 + 有兜底），
 *     不是"它在两个方向都赢"。
 *
 * 最要紧的一条在最末：**`docs/RULES.md` 里声明的每个门禁，必须真的挂在
 * `scripts/verify.js` 的链上**。否则"在规则表里加了个门禁、却忘了挂进 verify"
 * 会静默失效 —— 规则文件说它守着，实际它一次都不跑。这与本工程反复修过的
 * 「没做，却看不出没做」同型。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const verify = require('../scripts/verify.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 口径实现（**全文件唯一定义**）：nearest-rank 百分位。
 *  n=10 时 `P90 = 第 9 个值 = 第二大` ⇒ **只丢最大的那 1 条**。
 *  ⚠️ 从 2026-10-19 起**它不再参与判定**，只进报错报文（让读者看见"尖峰有多大"）；
 *  判定用下面的 `medianOf`。保留它是因为"P90 与 median 差多少"本身是读数的一部分。 */
function p90Of(values) {
  const a = values.slice().sort((x, y) => x - y);
  return a[Math.max(1, Math.ceil(0.9 * a.length)) - 1];
}

/** 判定口径（**全文件唯一定义**）：median。偶数个取中间两个的均值。
 *  n=10 时 = 第 5/6 个值的均值 ⇒ **要 6 条读数进入新高度才动**（这条性质由下面那条结构判定钉住）。 */
function medianOf(values) {
  const a = values.slice().sort((x, y) => x - y);
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/** 造一条结果记录 */
const res = (gate, ms, budgetMs, skipped) => ({
  step: 0, gate, label: gate, ms, code: 0, budgetMs, skipped: !!skipped
});

/** 从验证历史（`.review/verify-history.jsonl`）取**真读数**：最近 K 次**成功**的全链，
 *  逐门禁取**窗口内该步的全部读数**，统计量由调用方按口径取。返回
 *  `{ runs, byGate, byGateMax, byGateP90, byGateMedian }`（没有可用历史 ⇒ `runs: 0` 且表都是 `{}`）。
 *
 *  为什么**现读**而不是写死一张表：写死的表会静静过期 —— 本文件原先那张记的是 G5≈51s，
 *  而被取代时真值已是 235–421s（差 5–8 倍），于是"余量 > 1.8×"这条守卫**绿着却什么都没守** ✗。
 *
 *  ## median 口径：换它的**理由**与**代价**（2026-10-19 本批；三改口径：max → P90 → median）
 *  这一节的存在理由，是上一节留下的教训：`b73c7ae` 换口径时写下了
 *  「P90 = 第 9 个值 = 第二大 ⇒ **只丢最大的那 1 条**」—— **那是在描述缺陷**，当时却当成了优点。
 *  ⇒ 本节的每条结论都配一个**机械判定**（下面那几条 `it`）或一条**实测读数**（脚本在
 *  `.review/20261019-预算统计量/`），不接受"听起来更稳"这种理由。
 *
 *  **① 为什么还要再换（P90 的病）**：n=10 时 P90 = **第二大** ⇒ **只容忍 1 条尖峰**，第 2 条就翻红。
 *  当天两次实测：一次尖峰把线 1300→**1468**（比值 1.0002，没有牙）；一次方差把线 1300→**1350**（1.2435）。
 *  第二次那条 1 074 073ms 已经被证明是负载尖峰（同一次 run 的 G3 = 1.31×、G4 = 0.98×，**不同向**；
 *  紧接着的单跑 966.2s 比窗口里 10 条全部更快）⇒ 为它抬线是**为一次方差付钱**。
 *
 *  **② 抗尖峰：median 确实更好（这一半成立）**
 *   · `max` 丢 0 条、`P90` 丢 1 条、`P75` 丢 2 条、`median` 丢 5 条 ⇒ 要它动需要 **6 条**读数变慢；
 *   · 实测：预算 1300000 时逐窗口回溯全部历史，`1.25×` max 触发 **15/168**、P90 **3/168**、
 *     P75 **0/168**、median **0/168**（分母 = 177 条 full 档读数可组成的 168 个窗口；
 *     ⚠️ 分母随历史增长会变，**现值以 `.review/20261019-预算统计量/firing-rate.js` 现算为准**，别抄这行）。
 *
 *  **③ 发现持续变慢：median 更慢，不是更快 —— 这是**取舍**，如实记 ✗→✓**
 *   · 构造（慢档 1200 / 快档 900，逐条进入窗口）：要抬到慢档，max 第 **1** 条 · P90 第 **2** 条 ·
 *     P75 第 **3** 条 · median 第 **6** 条；
 *   · 历史 6 处"长台阶"（平台 ≥6 条）上实测滞后中位数：max **0** 条 · P90 **1.5** 条 ·
 *     P75 **2.5** 条 · median **8.5** 条。
 *     ⚠️ 8.5 > 6 不矛盾：**6 条**是构造上的界（"新水平立刻平稳"时 6 条读数进新高度即到位）；
 *     历史实测更多，是因为那段时期的水平**还在继续往上走**（目标本身一直在抬）。
 *     ⇒ 引用这两个数时别混用：**界**看构造，**实测**看长台阶。
 *  ⇒ 说 "median 对持续变慢更敏感" 是**错的**（父代理给的那张表在这一列把 P90 写成了"需 9 条"，
 *    nearest-rank 的实际行为是 **2 条**：窗口里 2 条读数到新高度时，排序后第 9 个就是新高度）。
 *  **那为什么还是选它**：滞后的**代价形状**不同 ——
 *    · 它**有界**：构造上 ≤5 条读数（要 6 条进新高度才会动）；
 *    · 它**有兜底**：新高度那条读数如果越过预算，`checkBudgets()` 的**逐步骤判定当场红**
 *      （与统计量无关）⇒ 迟到的只是"该重校准了"的提示，不是"慢化被发现了没有"；
 *    · 它**不会造出随机红灯**：这正是抬线最贵的那一侧（`A2c`：一次红的代价 = 全链耗时 × 重跑次数）。
 *
 *  **④ 那"一半慢一半快"的混合会不会被它掩盖？**（父代理点名要量的反例）
 *   · 构造：5 条 1200 + 5 条 900 ⇒ median 读到 **1050**（落在两档之间），
 *     `1.25 × 1050 = 1312 > 1200` ⇒ **慢档读数不会越过这条线** ⇒ 不算掩盖；
 *   · 代数边界：混合窗口 `1.25 × (S+F)/2 ≥ S ⇔ S ≤ 1.667 × F` ⇒ 两档相差 **> 66.7%** 才会真掩盖
 *     （下面有一条 `it` 把这个边界与它的越界反例一起钉住，防止有人以为 median 无界安全）；
 *   · 全历史核查（定义：**守卫说绿、而窗口里真有一条读数越过预算**）：**0 / 167 个窗口**。
 *   · 历史判例：没有一段"典型水平连续上升"被 median 读成绿（12/12 段同步抬，实测在
 *     `counterexample.js` 的①）。
 *
 *  **⑤ 为什么不是 P75**：它在 1300000 下余量只有 5 874ms（0.45%），判决最接近 median 却在
 *  4/167 个窗口里出现"读数越过 1.25×P75"（比 P90 的 2/167 还多）⇒ 两头的优点都没拿到。
 *
 *  **⑥ 这条不变量守的是什么**：它不判"快慢好不好"，只判**预算有没有跟着真实慢端重算**。
 *  真判错时的正确动作是**改预算并在 `scripts/verify.js` 里说明理由**，而不是把这条守卫调松 ✗。
 *  升级触发条件（写给下一次）：median 涨到 ≥ `预算/1.25` ⇒ 本条判红 ⇒ 先分辨「工作量增长 / 机器负载」
 *  （分辨法：看**同一次 run 的 G3、G4 是否同向同量级大涨** —— 那是负载的指纹），再决定抬线；
 *  **降线也走同一条路**（本批就把多付的 50s 还回去了），但降线必须同批给"逐窗口回溯历史全绿"的读数。
 *
 *  为什么是最近 **K=10** 次：太远的历史会掩盖"最近真的变慢了"；只取最近 1 次则等于拿一天的
 *  负载当基线。实测（2026-10-12..10-19 的 full 档 G5 读数）：**每天 2–24 条、近 8 天合计约 90 条**
 *  ⇒ 10 条 ≈ **半个到一天**。⚠️ 上一版这里写的"全量档约每天一次"是**错的**（实测差一个量级），
 *  它同时是"median 滞后 6–9 条 ≈ 滞后好几天"这个担心的前提 —— 前提不成立。
 *
 *  为什么只认"成功且非 partial"的记录：失败/中断那次步骤没跑完，`--changed` 只跑了几步 ——
 *  两种都不是真值口径（与 `scripts/verify.js` 的 `pickHistoryBaseline` 同一口径 ✓）。 */
function recentMeasured(k) {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, verify.VERIFY_HISTORY), 'utf8'); }
  catch (e) { return { runs: 0, byGateMax: {} }; }   // `.review/` 是可随时整包删掉的工作产物区
  const ok = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (e) { continue; }   // 坏行跳过（历史里可能有半截行）
    if (r && r.ok === true && r.partial !== true && Array.isArray(r.steps)) ok.push(r);
  }
  const win = ok.slice(-k);
  const byGate = {};
  for (const r of win) {
    for (const s of r.steps) {
      // skipped 的步骤 ms=0（与上一步共用一次调用）⇒ 不能读成"这一步很快"
      if (!s || s.skipped === true || typeof s.ms !== 'number' || s.ms <= 0) continue;
      (byGate[s.gate] = byGate[s.gate] || []).push(s.ms);
    }
  }
  // 三个统计量都返回：**判定只用 median**，max 与 P90 只进报错报文（让读者看见"尖峰有多大、与中位差多少"）
  const byGateMax = {};
  const byGateP90 = {};
  const byGateMedian = {};
  for (const g of Object.keys(byGate)) {
    byGateMax[g] = Math.max.apply(null, byGate[g]);
    byGateP90[g] = p90Of(byGate[g]);
    byGateMedian[g] = medianOf(byGate[g]);
  }
  return { runs: win.length, byGate, byGateMax, byGateP90, byGateMedian };
}

/* ============================================================================
 * 分层之后，`G5` 的读数窗口要**单独取**（2026-10-18 加）
 * ----------------------------------------------------------------------------
 * **统计量**已改（2026-10-19 本批）：现在是 **median**（理由与代价见上面「median 口径」一节）。
 * 变的还有"读哪个窗口"——因为 `recentMeasured` 取的是**最近 10 条记录**，而分层之后这 10 条里
 * 绝大多数是 **fast 档**（只跑 core 域，实测约全量档的 1/5）。照旧窗口会有两种坏结果：
 *   ① 拿快档读数当基准 ⇒ 守卫对着一个小数字空转（绿着，什么都没守）；
 *   ② 若改口径"只认全量档"却仍只看最近 10 条 ⇒ 窗口里可能**一条 G5 全量读数都没有** ⇒
 *      守卫**完全不判 G5**（静默失去守卫，比假红更坏）。
 * ⇒ 取「**跨全部历史**最近的 K 次**全量档** G5 读数」。
 * ⚠️ 代价如实说（**换 median 之后这条又变了**，别照旧读）：全量档**不是**每天一次（实测每天 2–24 条），所以
 *  · 换 P90 **之前**：一条尖峰会让预算被抬高，并在窗口里赖满 K 条读数；
 *  · 换 median **之后**：**单条尖峰抬不动线**（要 6 条才动），代价换成"持续慢化滞后 6–9 条读数"
 *    （≈ 半天到一天；见上面那一节 ③ 与 CHANGELOG 的偏差一节）。
 * ========================================================================= */
function recentFullG5(k) {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, verify.VERIFY_HISTORY), 'utf8'); }
  catch (e) { return { readings: [], max: null, p90: null, median: null, lastAt: null }; }
  const readings = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (e) { continue; }
    if (!r || r.ok !== true || r.partial === true || !Array.isArray(r.steps)) continue;
    const s = r.steps.filter((x) => x && x.gate === 'G5')[0];
    if (!s || s.skipped === true || typeof s.ms !== 'number' || s.ms <= 0) continue;
    // 老记录没有 tier 字段 ⇒ 分层之前 G5 跑的就是全部域
    if (s.tier !== undefined && s.tier !== 'full') continue;
    readings.push({ at: r.at, ms: s.ms });
  }
  const win = readings.slice(-k);
  const ms = win.map((x) => x.ms);
  return {
    readings: win,
    max: ms.length ? Math.max.apply(null, ms) : null,
    p90: ms.length ? p90Of(ms) : null,
    median: ms.length ? medianOf(ms) : null,
    lastAt: win.length ? win[win.length - 1].at : null
  };
}

describe('验证链耗时预算：判定逻辑', () => {  it('全在预算内 → 不报超预算，合计正确', () => {
    const r = verify.checkBudgets([res('G1', 100, 10000), res('G8', 200, 10000)], 150000);
    expect(r.overStep).toEqual([]);
    expect(r.overTotal).toBe(false);
    expect(r.totalMs).toBe(300);
    expect(r.ranCount).toBe(2);
  });

  it('单步超预算 → 精确点名那一步', () => {
    const r = verify.checkBudgets([res('G1', 100, 10000), res('G4', 45000, 30000)], 150000);
    expect(r.overStep.map((x) => x.gate)).toEqual(['G4']);
  });

  it('每步都没超、但**合计**超 → 仍要红（防"每样都慢一点"）', () => {
    const r = verify.checkBudgets([res('G1', 9000, 10000), res('G8', 9000, 10000)], 15000);
    expect(r.overStep).toEqual([]);
    expect(r.overTotal).toBe(true);
    expect(r.totalMs).toBe(18000);
  });

  it('budgetMs 为 0 的步骤不参与判定（G7 与 G6 共用一次调用）', () => {
    const r = verify.checkBudgets([res('G7', 0, 0, true)], 150000);
    expect(r.overStep).toEqual([]);
    expect(r.ranCount).toBe(0);
    expect(r.totalMs).toBe(0);
  });

  it('**这才是预算存在的理由**：历史上"每条断言起一个进程"的 102 s 必须被抓住', () => {
    const g4 = verify.checkBudgets([res('G4', 102100, 30000)], 150000);
    expect(g4.overStep.map((x) => x.gate)).toContain('G4');
  });

  it('**整链 176 s 那一版也必须被合计预算抓住**', () => {
    const old = verify.checkBudgets([
      res('G1', 900, 10000), res('G8', 900, 10000), res('G9', 900, 10000),
      res('G3', 8000, 60000), res('G4', 102100, 30000), res('G5', 51000, 120000),
      res('G2', 900, 15000), res('G6', 8000, 40000)
    ], 150000);
    expect(old.overTotal).toBe(true);
    expect(old.totalMs).toBeGreaterThan(150000);
  });

  it('预算留足余量：**典型水平**离预算还有 1.25 倍以上（口径 = 窗口 median；否则会变成随机红灯）', () => {
    // 实测**现读** `.review/verify-history.jsonl` 的真读数，**不写死数字**（原因见 recentMeasured 上方）✓
    // 口径：**预算 ≥ 1.25 × 窗口内该步的 median**（n=10 ⇒ 第 5/6 个值的均值；理由与代价见上面「median 口径」一节）
    const { runs, byGateMax, byGateP90, byGateMedian } = recentMeasured(10);
    if (!runs) {
      // 没有历史（首次运行 / `.review/` 被清理过）⇒ 本项**未判定**，**不是**"通过" ✗（措辞必须让人看出区别）。
      // 窗口为空（历史文件在、但一条"成功且非 partial"的记录都没有）走的是**同一条分支**：
      // 同样只 warn、不判红 —— 理由同上（`.review/` 可随时整包删；缺了只当"未知"）。
      // ⚠️ 但**不许静默**：这一档一定会打印这条 warn（"未判定 ≠ 通过"），judged 也仍会是 0 ⇒
      //    下面那条 `judged > 0` 的断言会一起把"守卫空转"这件事说出来 ✓。
      console.warn('⚠️ 预算余量：**未判定** —— 没有可用的验证历史（' + verify.VERIFY_HISTORY
        + ' 不存在 / 窗口里还没有成功记录）。要判定请先跑一次全链（`npm run verify`）。这一条**不是**通过 ✗');
      return;
    }
    let judged = 0;
    /* G5 的读数**单独取**（分层之后它可能整轮是 fast 档）：见 `recentFullG5` 上方那一节。
     * 取不到全量档读数时**不静默**：响亮说明"这一条本轮不判"，并靠下面 `judged > 0` 保证
     * 不会整体空转。 */
    const g5full = recentFullG5(10);
    if (g5full.max !== null) {
      byGateMax.G5 = g5full.max; byGateP90.G5 = g5full.p90; byGateMedian.G5 = g5full.median;
    } else {
      console.warn('⚠️ G5 的预算余量：**未判定** —— 历史里还没有一条**全量档**的 G5 读数'
        + '（分层之后快档不算）。要判定请跑一次 `npm run verify -- --release`。这一条**不是**通过 ✗');
      delete byGateMax.G5;
      delete byGateP90.G5;
      delete byGateMedian.G5;
    }
    for (const s of verify.STEPS) {
      if (!s.budgetMs || !byGateMedian[s.gate]) continue;   // 历史里没有读数的门禁（如新增步骤）无从判定
      judged++;
      const med = byGateMedian[s.gate];
      const need = 1.25 * med;
      expect(s.budgetMs / med, s.gate + ' 的预算余量（基准 = 最近 ' + runs
        + ' 次成功全链里的 **median** = ' + med + 'ms ⇒ 1.25× = ' + Math.round(need)
        + 'ms，预算 ' + s.budgetMs + 'ms；同窗口 P90 = ' + byGateP90[s.gate]
        + 'ms、max = ' + byGateMax[s.gate] + 'ms —— 这两个只作参照，不参与判定）')
        .toBeGreaterThanOrEqual(1.25);
    }
    expect(judged, '至少要判定一个门禁（否则这条守卫等于空转 ✗）').toBeGreaterThan(0);
  });

  /* ---------------------------------------------------------------
   * **口径的判别力证明**（换个口径之后必须重新证明它没被换废，`testing-for-ai` B4）：
   * 换 median 的**唯一前提**是"它不会掩盖真实慢化"。上面那段注释是理由，这里是**判定**：
   *   ① 1–5 条慢 ⇒ median 不动或只到两档中间（尖峰抬不动线 —— 这是换它的理由）；
   *   ② 6 条慢 ⇒ 抬到新高度（**这是它的已知滞后，同时是它的生效条件**，必须钉住）；
   *   ③ 「一半慢一半快」的混合**不会让慢档越过它定的线**，并给**代数边界**（S ≤ 1.667×F）；
   *   ④ 越过边界的构造**必须**出现掩盖（否则"边界"就是空话，而 median 会被当成无界安全）；
   *   ⑤ median ≤ P90 恒成立 ⇒ 换口径只会**减少**抬线压力，不会把任何门禁弄得更紧（单调性）。
   * 少任何一条，这条口径就退化成"永远不动的中位数"或"另一个 max"，换它就没有意义 ✗。
   * --------------------------------------------------------------- */
  it('**median 的边界**：要 6 条慢读数才抬线，且「一半慢一半快」在 1.667× 以内不会掩盖', () => {
    const base = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109];
    // n=10 时 median = 第 5/6 个值的均值 ⇒ (104+105)/2 = 104.5
    expect(medianOf(base), 'n=10 的 median 必须是 104.5（若等于 109 那就是 max、等于 108 那就是 P90 ✗）').toBe(104.5);

    // ① 尖峰抬不动线：把 1 条读数从 109 抬到 300，median 一个字节都不许动
    const oneSlow = base.slice(); oneSlow[9] = 300;
    expect(medianOf(oneSlow), '只有 1 条读数变慢时 median 必须**不动** —— 那是尖峰，不是趋势').toBe(104.5);

    // ② 要 6 条才抬：5 条慢只到两档中间，6 条慢才满格（**这条同时钉住它的已知滞后**）
    const k5 = base.map((x, i) => (i >= 5 ? 300 : x));   // 5 条慢（第 6..10 条）⇒ 排序后 100..104 + 300×5
    expect(medianOf(k5), '5 条慢读数时 median 只到 (104+300)/2 = 202（这就是"滞后"它的形状：只抬了一半）').toBe(202);
    const k6 = base.map((x, i) => (i >= 4 ? 300 : x));   // 6 条慢
    expect(medianOf(k6), '6 条慢读数时 median 必须抬到新高度 300（抬不动就说明它在掩盖真实慢化 ✗）').toBe(300);
    // 对照：同一组 6 条慢读数下 P90 早就满了 —— 这也是"median 更慢"的机械证据（不是感觉）
    expect(p90Of(k6), 'P90 在同一组数据上是 300 ⇒ 两个口径"几条才动"的差别是真实的').toBe(300);
    expect(p90Of(base.map((x, i) => (i >= 8 ? 300 : x))), 'P90 只需 2 条慢读数就满格 ⇒ 它比 median 快 4 条').toBe(300);

    // ③「一半慢一半快」构造实验（父代理点名要量）：5 条 1200 + 5 条 900
    const SLOW = 1200000, FAST = 900000;
    const mix = [SLOW, SLOW, SLOW, SLOW, SLOW, FAST, FAST, FAST, FAST, FAST];
    expect(medianOf(mix), '5+5 混合时 median = (1200+900)/2 = 1050（落在两档之间，不是快档也不是慢档）')
      .toBe(1050000);
    expect(1.25 * medianOf(mix), '1.25×median 必须**容得下慢档本身**（1312.5s > 1200s）⇒ 慢档读数不越线')
      .toBeGreaterThan(SLOW);
    // 代数边界：混合窗口 1.25×(S+F)/2 ≥ S ⇔ S ≤ 1.25/0.75 × F
    const bound = 1.25 / 0.75;
    expect(bound.toFixed(4)).toBe('1.6667');
    expect(1.25 * ((FAST * bound) + FAST) / 2, '边界点上 1.25×median 正好等于慢档本身').toBeCloseTo(FAST * bound, 6);

    // ④ **越界必须掩盖**（否则"边界"是空话）：慢档是快档的 1.8× ⇒ 5+5 混合下 1.25×median < 慢档
    const S2 = FAST * 1.8;
    const mix2 = [S2, S2, S2, S2, S2, FAST, FAST, FAST, FAST, FAST];
    expect(1.25 * medianOf(mix2), '慢档 = 1.8×快档时 1.25×median **低于**慢档 ⇒ 这就是 median 的真实边界，'
      + '写在这里是为了让下一次知道它**不是**无界安全，而不是等它真的发生').toBeLessThan(S2);

    // ⑤ 单调性：median ≤ P90 恒成立 ⇒ 换口径只会减少抬线压力，不会把任何门禁弄得更紧
    for (const w of [base, oneSlow, k5, k6, mix, mix2]) {
      expect(medianOf(w), 'median ≤ P90 必须在任何窗口上成立（否则换口径可能反而把某个门禁弄红 ✗）')
        .toBeLessThanOrEqual(p90Of(w));
    }
  });
});

describe('验证链定义自洽（scripts/verify.js 是唯一定义）', () => {
  it('门禁编号不重复，且顺序就是文档里承诺的那条链', () => {
    const gates = verify.STEPS.map((s) => s.gate);
    expect(new Set(gates).size).toBe(gates.length);
    // V2（冒烟域内自收尾）与 V1 同档：都是"扫冒烟源码文本"的廉价卫生门禁，排在昂贵步骤之前 ✓
    // S1/S2/S3（结构声明的三条卫生门禁）同档：依赖方向 / 连带清单 / 产物确定性，同样是纯文本扫描 ✓
    expect(gates).toEqual(['G1', 'G8', 'G9', 'V1', 'V2', 'S1', 'S2', 'S3', 'S4', 'G3', 'G6', 'G7', 'G4', 'G2', 'G5']);
  });

  it('除 G7（与 G6 同一次调用）外，每步都有可执行命令与预算', () => {
    for (const s of verify.STEPS) {
      if (s.gate === 'G7') { expect(s.cmd).toBe(null); continue; }
      expect(typeof s.cmd, s.gate).toBe('string');
      expect(s.budgetMs, s.gate).toBeGreaterThan(0);
      expect(s.shown.length, s.gate).toBeGreaterThan(0);
      expect(s.covers.length, s.gate).toBeGreaterThan(0);
    }
  });

  it('**`docs/RULES.md` 声明的每个门禁都真的挂在链上**（防"加了门禁忘了挂"）', () => {
    const rules = fs.readFileSync(path.join(ROOT, 'docs', 'RULES.md'), 'utf8');
    // 前缀 `G`（功能与契约）/ `V`（验证物自身的卫生）/ `S`（结构声明的卫生）三种都认
    const declared = [...rules.matchAll(/^\|\s*\*\*([GVS]\d+)\*\*/gm)].map((m) => m[1]);
    const mounted = verify.STEPS.map((s) => s.gate);
    expect(declared.length, 'RULES.md 里应声明多个门禁').toBeGreaterThan(5);
    const missing = declared.filter((g) => !mounted.includes(g));
    expect(missing, '这些门禁在 RULES.md 里声明了，却没挂进 scripts/verify.js 的 STEPS').toEqual([]);
  });

  /* ------------------------------------------------------------
   * **反方向**：挂了门禁但没人声明 —— 与上一条同一个"谁守门禁"元问题的另一半。
   *
   * 为什么需要（实测缺陷，2026-10-10）：V1/V2 挂进 `STEPS` 已多日，而 `docs/RULES.md` §2 表里
   * **至今没有它们** ⇒ 接手者查规则表**根本不知道这两条门禁存在**。
   * 上一条只守"声明 ⊆ 实现"（防加了门禁忘了挂），**不守"实现 ⊆ 声明"** —— 这是它的对偶缺口。
   * 两向都判红才是闭包，且两边差集都要**点名**（`docs-for-ai` G6 的"声明 ↔ 实现双向"）。
   * ------------------------------------------------------------ */
  it('**反向：链上实现的每个门禁都必须在 `docs/RULES.md` §2 有声明**（防"挂了门禁没人声明"）', () => {
    const rules = fs.readFileSync(path.join(ROOT, 'docs', 'RULES.md'), 'utf8');
    const declared = [...rules.matchAll(/^\|\s*\*\*([GVS]\d+)\*\*/gm)].map((m) => m[1]);
    const mounted = verify.STEPS.map((s) => s.gate);
    const undeclared = mounted.filter((g) => !declared.includes(g));
    expect(undeclared, '这些门禁挂在 scripts/verify.js 的 STEPS 上，却没在 docs/RULES.md §2 声明'
      + '（接手者查规则表查不到它们存在 ⇒ 把声明补进 §2 的门禁表）').toEqual([]);
  });

  it('package.json 的 verify 指向本 runner（不是又一份手抄的 && 链）', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.verify).toBe('node scripts/verify.js');
  });
});

/* ============================================================================
 * 两条**结构性不变量**的机械守卫（批 J，2026-10-13）
 * ----------------------------------------------------------------------------
 * 这两条原先只写在注释里（`scripts/verify.js` 的 `TOTAL_BUDGET_MS`、`main.js` 的 `SMOKE_GUARD_MS`）。
 * **注释不是守卫**：有人改坏它时不会变红 —— 而这两条恰恰是"改坏了也看不出"的典型，
 * 因为坏掉的形状是**假红 / 假崩**（2026-10-13 两次真红就是这样来的：G5 用 304.6s 跑完、
 * 判据全绿，却在 300s 被守卫掐掉，报文里只剩 `SMOKE GUARD TIMEOUT — force exit` ✗）。
 *
 * 两条都**从代码现读**、不抄数字。抄一份进测试 = 同一件事有两处表达 ⇒ 下次改预算时，
 * 测试里那份**不会自动跟着变**，于是它守的只是那份抄本，而不是线上真正生效的那个数
 * （本工程反复修过的同型病：文档与代码各写一份事实）。
 * ⚠️ 读不到（正则不匹配 / 找不到 G5）**判红**，不跳过：那不是"没违反"，而是"**这条不变量没被验证**" ✗。
 * ========================================================================= */
describe('两条不变量的机械守卫（从代码现读，不抄数字）', () => {
  it('① `main.js` 的冒烟守卫 > G5 预算（守卫先触发会把"跑完且全绿、只是机器慢"报成崩溃）', () => {
    // 为什么解析源码而不是 require：main.js 是 Electron 主进程入口，require 它会在测试进程里
    // 启动应用（app / BrowserWindow 都要真的跑起来）⇒ 只能文本现读（与 G8 读 main.js 的方式同类）。
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const m = src.match(/const\s+SMOKE_GUARD_MS\s*=\s*(\d+)\s*;/);
    expect(m, 'main.js 里找不到 `const SMOKE_GUARD_MS = <数字>;` —— 读不到不算"没违反"，'
      + '而是"这条不变量没被验证" ⇒ 判红（也别让守卫随一次重命名静默消失 ✗）').toBeTruthy();
    const guardMs = Number(m[1]);
    const g5 = verify.STEPS.find((s) => s.gate === 'G5');
    expect(g5, 'scripts/verify.js 的 STEPS 里应有 G5').toBeTruthy();
    expect(guardMs, '冒烟守卫（main.js 的 SMOKE_GUARD_MS = ' + guardMs + 'ms）必须**大于** G5 的预算（'
      + g5.budgetMs + 'ms）：守卫先触发会把"其实跑完了、判据全绿、只是机器慢"的一次报成崩溃，'
      + '报文里只剩 SMOKE GUARD TIMEOUT — force exit ✗（预算判"太慢"、守卫只拦"真挂死"，'
      + '两者代价不对等 ⇒ 守卫必须永远更大）').toBeGreaterThan(g5.budgetMs);
  });

  it('② 合计预算 ≥ 各步预算之和（否则合计会抢在单步前面报红，盖掉真正慢的那一步）', () => {
    const sum = verify.STEPS.reduce((n, s) => n + (s.budgetMs || 0), 0);
    expect(sum, '各步预算之和应大于 0（STEPS 读坏了？）').toBeGreaterThan(0);
    expect(verify.TOTAL_BUDGET_MS, '合计预算（' + verify.TOTAL_BUDGET_MS + 'ms）必须 ≥ 各步预算之和（'
      + sum + 'ms，从 STEPS 现算）：合计红只说"整条链慢了"、说不出是哪一步 ⇒ 它不许抢在单步前面发声')
      .toBeGreaterThanOrEqual(sum);
  });
});

/* ============================================================================
 * G5 **分层**（2026-10-18 加）：档位判定 + 两条线 + 跨档不可比
 * ----------------------------------------------------------------------------
 * 为什么这些必须是单测而不是注释：分层的全部风险是"**该跑全量的那一轮跑了快档，而没人看得出来**"。
 * 判据（`B4` 判别力证明）：**逐条触发条件各注入一次 ⇒ 档位必须变成 full**；把触发条件拿掉 ⇒ 回到 fast。
 * 少守一条，就等于给"抽样"开了一个没有守卫的口子（而口子开着时，输出看起来完全正常）。
 * ========================================================================= */
describe('G5 分层：decideG5Tier（纯函数；逐条触发条件都能判）', () => {
  const HOUR = 3600 * 1000;
  const NOW = Date.parse('2026-10-18T12:00:00.000Z');
  const fresh = { at: new Date(NOW - HOUR).toISOString(), ok: true };      // 1 小时前成功跑完全量档
  const clean = (o) => Object.assign({ now: NOW, lastFull: fresh, changedFiles: ['renderer/app.js'] }, o);

  it('全部条件都不成立 ⇒ fast（这是唯一的"省时间"出口，且必须是默认）', () => {
    const d = verify.decideG5Tier(clean({}));
    expect(d.tier).toBe('fast');
    expect(d.hits).toEqual([]);
  });

  it('`--release`（放行点 / 交付前）⇒ full', () => {
    const d = verify.decideG5Tier(clean({ release: true }));
    expect(d.tier).toBe('full');
    expect(d.hits.map((h) => h.code)).toContain('release');
  });

  it('`--g5=full` ⇒ full', () => {
    const d = verify.decideG5Tier(clean({ explicit: 'full' }));
    expect(d.tier).toBe('full');
    expect(d.hits.map((h) => h.code)).toContain('explicit-full');
  });

  it('历史里没有全量档记录 ⇒ full（"不知道"不是绿）', () => {
    const d = verify.decideG5Tier(clean({ lastFull: null }));
    expect(d.tier).toBe('full');
    expect(d.hits.map((h) => h.code)).toContain('no-full-record');
  });

  it('上次全量档是红的 ⇒ full（不许用快档把已知的 deep 缺陷洗掉）', () => {
    const d = verify.decideG5Tier(clean({ lastFull: { at: new Date(NOW - HOUR).toISOString(), ok: false } }));
    expect(d.tier).toBe('full');
    expect(d.hits.map((h) => h.code)).toContain('last-full-red');
  });

  it('距上次成功全量档 ≥ 24h ⇒ full（"每日一档"这条不许靠人记得）', () => {
    const old = { at: new Date(NOW - 25 * HOUR).toISOString(), ok: true };
    const d = verify.decideG5Tier(clean({ lastFull: old }));
    expect(d.tier).toBe('full');
    expect(d.hits.map((h) => h.code)).toContain('stale');
    // 边界：正好 23h 还不该升档（否则它会天天升、快档永远跑不到）
    const young = { at: new Date(NOW - 23 * HOUR).toISOString(), ok: true };
    expect(verify.decideG5Tier(clean({ lastFull: young })).tier).toBe('fast');
  });

  it('取不到改动清单（没有 git / 不在仓库里）⇒ full（抽样没有依据）', () => {
    const d = verify.decideG5Tier(clean({ changedFiles: null }));
    expect(d.tier).toBe('full');
    expect(d.hits.map((h) => h.code)).toContain('no-changes');
  });

  it('改动命中冒烟底板 / 域文件 / main.js ⇒ full，并**点名**是哪些文件', () => {
    const d = verify.decideG5Tier(clean({
      changedFiles: ['renderer/app.js', 'scripts/smoke/46-节点级拖动.js', 'scripts/smoke-select.js', 'main.js']
    }));
    expect(d.tier).toBe('full');
    const floor = d.hits.filter((h) => h.code === 'floor')[0];
    expect(floor, '底板条件必须触发').toBeTruthy();
    expect(floor.why).toContain('scripts/smoke/46-节点级拖动.js');
  });

  it('改动只在产品代码 / 文档里 ⇒ **不**触发底板条件（否则"每次改界面都全量"，分层就白做了）', () => {
    const d = verify.decideG5Tier(clean({ changedFiles: ['renderer/app-view.js', 'docs/RULES.md', 'tests/a.test.js'] }));
    expect(d.tier).toBe('fast');
  });

  it('显式 `--g5=fast` 只压得过"该轮到全量了"，压不过硬条件', () => {
    const young = { at: new Date(NOW - HOUR).toISOString(), ok: true };
    // ① 只有周期条件 ⇒ 允许覆盖，但必须把**被覆盖的那条**说出来（跳过要与通过可区分）
    const stale = { at: new Date(NOW - 30 * HOUR).toISOString(), ok: true };
    const over = verify.decideG5Tier(clean({ lastFull: stale, explicit: 'fast' }));
    expect(over.tier).toBe('fast');
    expect(over.overrode.map((h) => h.code)).toEqual(['stale']);
    // ② 硬条件（上次红）⇒ 显式 fast 也不生效
    const red = verify.decideG5Tier(clean({ lastFull: { at: new Date(NOW - HOUR).toISOString(), ok: false }, explicit: 'fast' }));
    expect(red.tier).toBe('full');
    expect(red.hits.map((h) => h.code)).toContain('last-full-red');
    // ③ 底板被改 ⇒ 同样不生效
    const floor = verify.decideG5Tier(clean({ changedFiles: ['scripts/smoke/01-core.js'], explicit: 'fast' }));
    expect(floor.tier).toBe('full');
    expect(young.ok).toBe(true);
  });

  it('parseTierArgs：`--release` / `--g5=fast|full` 都认；非法值**当场报错**（不静默落回某一档）', () => {
    expect(verify.parseTierArgs(['node', 'x'])).toEqual({ release: false, explicit: null, error: null });
    expect(verify.parseTierArgs(['node', 'x', '--release']).release).toBe(true);
    expect(verify.parseTierArgs(['node', 'x', '--g5', 'fast']).explicit).toBe('fast');
    expect(verify.parseTierArgs(['node', 'x', '--g5=full']).explicit).toBe('full');
    const bad = verify.parseTierArgs(['node', 'x', '--g5=quick']);
    expect(bad.error, '写错的档位值必须报错 —— 静默落回默认等于"你以为在全量档里跑，其实没有"').toBeTruthy();
  });
});

describe('G5 分层：两条止涨线 + 跨档不可比 + 名单只有一处', () => {
  it('快档有自己的止涨线，且必须**明显小于**全量档的线（否则"分层"没省任何东西）', () => {
    const g5 = verify.STEPS.find((s) => s.gate === 'G5');
    expect(verify.G5_FAST_BUDGET_MS).toBeGreaterThan(0);
    expect(verify.G5_FAST_BUDGET_MS, '快档预算必须小于全量档预算（实测快档约 1/5）')
      .toBeLessThan(g5.budgetMs * 0.5);
  });

  it('冒烟守卫仍 > 全量档预算（不变量①不因为分层而失效）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const guardMs = Number(src.match(/const\s+SMOKE_GUARD_MS\s*=\s*(\d+)\s*;/)[1]);
    const g5 = verify.STEPS.find((s) => s.gate === 'G5');
    expect(guardMs).toBeGreaterThan(g5.budgetMs);
  });

  it('historyDelta：G5 跨档**不给差**（快档 200s 与全量档 1017s 的差是假信号）', () => {
    const prev = { totalMs: 1100000, steps: [{ gate: 'G5', ms: 1017000, tier: 'full' }] };
    const d = verify.historyDelta(prev, [{ gate: 'G5', ms: 200000, tier: 'fast' }], 260000);
    expect(d.byGate.G5.ms).toBe(1017000);
    expect(d.byGate.G5.deltaMs, '跨档比出来的差必须为 null（打印成"—"），不许显示"快了 817s"').toBe(null);
    // 同档才给差
    const same = verify.historyDelta(prev, [{ gate: 'G5', ms: 1000000, tier: 'full' }], 1100000);
    expect(same.byGate.G5.deltaMs).toBe(-17000);
  });

  it('域名单**只有一处**：verify.js 不许手抄域号清单（单一权威 = smoke-assertions.js 的 TIERS）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'verify.js'), 'utf8');
    // 五个以上连续的两位数字字面量 = 一张手抄的域号清单
    const listLike = src.match(/'(\d{2})'(?:\s*,\s*'\d{2}'){4,}/);
    expect(listLike, 'verify.js 里出现了手抄的域号清单：分档名单只能写在 smoke-assertions.js 的 TIERS').toBe(null);
    expect(src).toContain('tierSummary()');
  });

  it('快档的"通过"必须当场降调（不许让读者把 core 域绿读成全部域绿）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'verify.js'), 'utf8');
    expect(src).toContain('fast 档');
    expect(src).toContain('不是全量真值');
    expect(src).toContain('--release');
  });
});

/* ============================================================
 * 用例数交接 —— 整条链只跑一次 vitest
 * ------------------------------------------------------------
 * 以前第 4 步 `npm test` 跑一次 vitest、第 8 步 `doc-facts` 为了**数用例数**又跑一次：
 * 慢约 5–9 s，而且那第二次在负载高时偶发取不到真值 → 按既定口径把 G6 判红
 * （实测 3 次里红 1 次）。现在第 4 步附带 JSON reporter 产出用例数，交给第 8 步。
 * 这几条锁的就是"交接别在以后的重构里悄悄断掉"—— 断了不报错，只是**又慢回去**，
 * 正是本工程反复修过的那类"退化了却看不出来"。
 * ============================================================ */
describe('P0-2 交接：用例数由链上传来，不重跑 vitest', () => {
  it('readUnitTests 取 numTotalTests；坏 JSON / 文件不存在 → null（下游降级自跑）', () => {
    const tmp = path.join(os.tmpdir(), 'vt-' + Date.now() + '.json');
    fs.writeFileSync(tmp, JSON.stringify({ numTotalTests: 416 }), 'utf8');
    expect(verify.readUnitTests(tmp)).toBe(416);
    fs.writeFileSync(tmp, 'not json at all', 'utf8');
    expect(verify.readUnitTests(tmp)).toBe(null);
    fs.unlinkSync(tmp);
    expect(verify.readUnitTests(tmp)).toBe(null);
    fs.writeFileSync(tmp, JSON.stringify({ numPassedTests: 416 }), 'utf8');
    expect(verify.readUnitTests(tmp)).toBe(null); // 只认 numTotalTests，不猜
    fs.unlinkSync(tmp);
  });

  it('第 4 步产出、第 8 步消费 —— 两端的接线都还在', () => {
    const g3 = verify.STEPS.find((s) => s.gate === 'G3');
    const g6 = verify.STEPS.find((s) => s.gate === 'G6');
    expect(g3.resultsFile).toBe(verify.TEST_RESULTS);
    expect(g3.cmd).toContain('--reporter=json');
    expect(g3.cmd).toContain('--reporter=default'); // 人看的输出不能丢
    expect(g3.cmd).toContain('outputFile=' + verify.TEST_RESULTS);
    expect(g6.useUnitTests).toBe(true);
  });

  it('交接文件落在 .review/（工程既定的工作产物区，且已 gitignore）', () => {
    expect(verify.TEST_RESULTS.startsWith('.review/')).toBe(true);
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    expect(gi).toMatch(/^\.review\/$/m);
  });

  it('doc-facts 保留降级路径：没有该环境变量时必须能自己跑（否则单独用就废了）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'doc-facts.js'), 'utf8');
    expect(src).toContain('AI_MINDMAP_UNIT_TESTS');
    expect(src).toContain('maxBuffer'); // 显式抬高，防 ENOBUFS 导致"真值缺失"误红
    expect(src).toMatch(/unitTestsSource/); // 来源必须打印出来（该被看见的事实）
  });
});

/* ------------------------------------------------------------
 * 兜底提示：**两个兜底互相替代不了**
 *
 * 真实背景：这条提示原先写的是「本工程 Git 零提交 ⇒ export-json 到工程外是**唯一**回滚手段」。
 * 2026-09-29 本地 Git 解锁后，那个前提**已经过时**。而反过来写（"有 Git 了 ⇒ 不用备份"）
 * 更危险：`.git` 与工程同盘，盘/整个目录丢了就一起没。
 * ⇒ 组文那一半抽成纯函数，这里把四种组合都钉住，防止它随某一次改动又倒向一边。
 * ------------------------------------------------------------ */
describe('兜底备份提示：本地 Git 与工程外备份各自独立', () => {
  it('无工程外备份 + 有本地提交 ⇒ 既说"已提交的可回滚"，也明说"救不了盘丢失"', () => {
    const t = verify.backupHintText(null, 3);
    expect(t).toContain('未找到工程外备份');
    expect(t).toContain('3 条提交');
    expect(t).toContain('救不了');
  });

  it('无工程外备份 + 零提交 ⇒ 不许出现"可回滚"这种话（那会让人以为没事）', () => {
    const t = verify.backupHintText(null, 0);
    expect(t).toContain('零提交');
    expect(t).not.toContain('可回滚');
  });

  it('取不到 git 状态 ⇒ 如实说"取不到"，不假装成零提交', () => {
    expect(verify.backupHintText(null, null)).toContain('取不到');
    expect(verify.backupHintText(null, null)).not.toContain('零提交');
  });

  it('有工程外备份 ⇒ 报新鲜度，且**仍然**带上本地 Git 状态（两条信息一起说）', () => {
    const t = verify.backupHintText({ days: 2 }, 5);
    expect(t).toContain('2 天前');
    expect(t).toContain('5 条提交');
  });

  it('gitCommitCount：返回非负数字或 null，绝不抛（仓库可能还没有提交 / 机器可能没装 git）', () => {
    const n = verify.gitCommitCount();
    expect(n === null || (typeof n === 'number' && n >= 0)).toBe(true);
  });
});

/* ============================================================================
 * 度量列（2026-10-08 加）："这次比上次快/慢了多少"要能显示出来，
 * 否则"这轮省下的时间"没人知道、也就没人守（本链真的从 77 s 涨回过 176 s ✗）。
 * 测的是**纯函数那一半** —— 打印格式与"缺数据时显示什么"都是会骗人的地方 ✓
 * ========================================================================= */
describe('度量列：与上一条历史比较（纯函数）', () => {
  const run = (gate, ms, skipped) => ({ gate, ms, skipped: !!skipped });

  it('逐门禁算差：正=变慢、负=变快', () => {
    const prev = { totalMs: 100000, steps: [{ gate: 'G5', ms: 90000 }, { gate: 'G3', ms: 10000 }] };
    const d = verify.historyDelta(prev, [run('G5', 95000), run('G3', 8000)], 103000);
    expect(d.byGate.G5).toEqual({ ms: 90000, deltaMs: 5000 });
    expect(d.byGate.G3).toEqual({ ms: 10000, deltaMs: -2000 });
    expect(d.total).toEqual({ ms: 100000, deltaMs: 3000 });
  });

  it('skipped 的步骤（与上一步共用一次调用，ms=0）**不参与比较** —— 比出来是假信号', () => {
    const prev = { totalMs: 100000, steps: [{ gate: 'G6', ms: 600 }, { gate: 'G7', skipped: true, ms: 0 }] };
    const d = verify.historyDelta(prev, [run('G6', 600), run('G7', 0, true)], 100000);
    expect(d.byGate.G6).toBeTruthy();
    expect(d.byGate.G7).toBeUndefined();
  });

  it('没有可比历史 ⇒ null（调用方据此打印"这是历史里的第一条"，**不是**显示 0）', () => {
    expect(verify.historyDelta(null, [run('G5', 1)], 1)).toBe(null);
    expect(verify.historyDelta({ steps: [] }, [run('G5', 1)], 1).byGate).toEqual({});
    // 上一条记录里没有这个门禁（新增了门禁）⇒ 该步不算差，但整表仍有输出
    const d = verify.historyDelta({ totalMs: 10, steps: [{ gate: 'G1', ms: 5 }] }, [run('G1', 6), run('G9', 7)], 20);
    expect(d.byGate.G1.deltaMs).toBe(1);
    expect(d.byGate.G9).toBeUndefined();
  });

  it('fmtDelta：总是带符号（正负一眼可辨），空值显示 —（不是 0.0s）', () => {
    expect(verify.fmtDelta(7600)).toBe('+7.6s');
    expect(verify.fmtDelta(-12300)).toBe('-12.3s');
    expect(verify.fmtDelta(0)).toBe('±0.0s');
    expect(verify.fmtDelta(null)).toBe('—');
    expect(verify.fmtDelta(undefined)).toBe('—');
    expect(verify.fmtDelta(NaN)).toBe('—');
  });

  it('readHistoryBaseline / pickHistoryBaseline：基线只认**最后一次成功**的验证', () => {
    // 失败/中断的那次步骤没跑完（合计 23.7s）⇒ 拿它比会得出"慢了 +101.7s"的假信号（实测踩到 ✗）
    const lines = [
      JSON.stringify({ ok: true, totalMs: 100000, steps: [{ gate: 'G5', ms: 90000 }] }),
      '{"半截坏行"',
      JSON.stringify({ ok: false, failedGate: 'G4', totalMs: 23700, steps: [{ gate: 'G3', ms: 18100 }] }),
      ''
    ];
    const b = verify.pickHistoryBaseline(lines);
    expect(b.totalMs).toBe(100000);
    expect(b.steps[0].gate).toBe('G5');
    // 全是失败/坏行 ⇒ null（调用方据此说"还没有一次成功的验证"，不编一个基线出来）
    expect(verify.pickHistoryBaseline([JSON.stringify({ ok: false, steps: [] })])).toBe(null);
    expect(verify.pickHistoryBaseline([])).toBe(null);
    expect(verify.pickHistoryBaseline(['', '   '])).toBe(null);
  });

  it('readHistoryBaseline：读不到历史文件时不抛（首次运行就是这么开始的）', () => {
    const t = verify.readHistoryBaseline();
    expect(t === null || typeof t === 'object').toBe(true);
  });
});
