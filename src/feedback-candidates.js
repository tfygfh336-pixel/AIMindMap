/* ============================================================
 * src/feedback-candidates.js — 「本地信号 → 反馈候选」的**唯一实现**（UMD 纯函数：零 DOM、零 I/O）
 * ------------------------------------------------------------
 * ## 它答什么
 * 点一颗星之后，那个框里"这次会话哪点让您不满意/满意？"下面的**选项**是从哪来的：
 *   ① `collectAnswerSignals(entry, st)` —— 只用界面上本来就有的信息采四个**信号**；
 *   ② `deriveFeedbackCandidates(sig, stars)` —— 信号 → 候选列表，**每条候选指回产生它的信号名**。
 * 零 AI 调用（省 token 纪律的本地半边）：全程没有模型、没有网络、没有时钟、没有随机数
 * ⇒ 同一输入恒等输出，所以它能被 node 直接单测（`tests/feedback-candidates.test.js`）。
 *
 * ## 为什么单独一个 `src/` 模块（R6 收尾批的实测缺口）
 * 这两个函数原住在 `renderer/app-ask.js`（IIFE，node 里 require 不了）⇒ **纯函数语义那一半没人守**：
 *   冒烟域 50 的 ② 是"DOM × 产品纯函数现算"的对拍，而**两侧同源**（`:296-298` 两侧都调
 *   `MM.askDeriveFeedbackCandidates`）⇒ 把纯函数改坏，两侧一起变、比对**恒等**
 *   ⇒ 实测：把候选改成固定写死之后，域 50 **18/18 全绿（漏过）**；只有把写死挪到
 *   "真正生成 DOM 那一跳"（2b 轮）才红 —— 也就是说 ② 只守得住"DOM 照纯函数画"，
 *   **守不住"纯函数自己的语义被写坏"**。这正是本工程反复治过的「两侧同源 ⇒ 对拍恒等 ⇒ 门禁空转」。
 * ⇒ 判据必须有**第二处、且期望值独立推出**：本模块（渲染层 `<script>` 与 node 单测共用一份）
 *   + `tests/feedback-candidates.test.js`（期望值由夹具手算，**不调本模块**）。
 * 形状照 `src/path-chain.js` / `src/feedback-…` 的先例：UMD、纯函数、零 DOM、零 I/O，
 * 于是"渲染层怎么画"与"单测怎么判"读的是同一份实现，不存在第二份会漂的口径。
 *
 * ## 信号（四个；名字就是候选的 `signal`，也是冒烟 ② 的词表）
 * | 信号 | 取值 | 边界（**只这一处**） |
 * |------|------|----------------------|
 * | `len` | `lenBucket ∈ {short, mid, long}` | `a.length < 200` ⇒ short；`> 1200` ⇒ long；其余 mid |
 * | `kind` | `explain`（讲解档）/ `ask`（问答档） | 只认 `st.kind === 'explain'`，其余一律 `ask` |
 * | `code` | `hasCode` | 回答里有 ``` 围栏，**或**行首（≤8 个空白）一个命令词 + 空白 |
 * | `mapWrite` | `mapWritten` | `entry.written` 为真 = 这条回答已被用户落进导图 |
 *
 * ## 候选（每条 `{text, signal}`）
 * `stars >= 4` ⇒ **满意档**措辞；否则（包括 `null` / `0` / 未点星）⇒ **不满意档**措辞。
 * 顺序固定：len → kind → code → mapWrite（**顺序是 DOM 里选项的先后**，也是判据的一部分）。
 * 信号没"点亮"的项**不出现**（mid 长度、没有代码、没落过图 ⇒ 少一个候选）。
 *
 * ## 上限（`ASK_FB_MAX_CANDIDATES`）
 * 常量 = 4（省 token 纪律的本地半边：候选先按信号出，超了就地截断）。
 * ⚠️ **如实边界（实测，别当"守住了截断"读）**：当前信号表能"点亮"的候选**最多就是 4 个**
 * （len 的 short/long 互斥 ⇒ 至多 1 个）⇒ `.slice(0, 4)` 在现有信号集下**永远不会真的截掉东西**
 * ⇒ 单测只能断言"≤ 上限"，**不能**断言"截断生效"（那会是恒假判据）。以后加信号才需要补截断判据。
 *
 * ## 消费者（两处，读同一份）
 *   · `renderer/app-ask.js`（渲染层，经 `<script src="../src/feedback-candidates.js">` 拿到
 *     `window.MMFeedbackCandidates`；它**只做薄转发**，不许再写一份实现）
 *   · `tests/feedback-candidates.test.js`（node，`require('../src/feedback-candidates.js')`）
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMFeedbackCandidates = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 候选数上限（常量；唯一一处）。见文件头「上限」—— 现有信号集下它不可达，别当截断判据用 */
  const ASK_FB_MAX_CANDIDATES = 4;

  /** 信号名取值表（候选的 `signal` 必须落在这四个里；冒烟 ② 的词表就是它） */
  const SIGNALS = ['len', 'kind', 'code', 'mapWrite'];

  /** 长度档的两个边界（**唯一一处**；单测直接锁这条口径） */
  const LEN_SHORT_BELOW = 200;
  const LEN_LONG_ABOVE = 1200;

  /** 命令行的形状：行首（允许最多 8 个空白）一个命令词 + 至少一个空白 + 非空参数。
   *  为什么这么窄：宽了会把"这句回答里提到了 npm"也算成代码 ⇒ 候选凭空多一条（假信号）。 */
  const CMD_LINE_RE = /(^|\n)[ \t]{0,8}(npm|npx|node|git|curl|wget|pip|python|cd|mkdir|cp|mv|rm|copy|del|dir|ls|cat|echo|set|export)\s+\S/;

  /**
   * 信号采集（**纯函数**）：只用界面上本来就有的信息，不读盘、不读时钟、不改入参。
   * @param {{a?:string, written?:boolean}|null|undefined} entry 会话日志里的一条回答
   * @param {{kind?:string}|null|undefined} st 这条会话（`kind:'explain'` ⇒ 讲解档）
   * @returns {{len:number, lenBucket:'short'|'mid'|'long', kind:'explain'|'ask',
   *            mapWritten:boolean, hasCode:boolean}}
   */
  function collectAnswerSignals(entry, st) {
    const a = String((entry && entry.a) || '');
    let hasCode = /```/.test(a);
    if (!hasCode) hasCode = CMD_LINE_RE.test(a);
    return {
      len: a.length,
      lenBucket: a.length > LEN_LONG_ABOVE ? 'long'
        : (a.length < LEN_SHORT_BELOW ? 'short' : 'mid'),
      kind: ((st && st.kind) === 'explain') ? 'explain' : 'ask',
      mapWritten: !!(entry && entry.written),
      hasCode: hasCode
    };
  }

  /** 措辞表（**唯一一处**）：每一档两位（不满意 / 满意）。`signal` 由键名给出 ⇒ 措辞与信号名不会各漂一格 */
  const TEXTS = {
    lenLong: { bad: '太长太啰嗦，重点不突出', good: '够详细、覆盖面全' },
    lenShort: { bad: '太简略，信息量不够', good: '简短直接，不绕弯' },
    kindExplain: { bad: '解释不够生动具体', good: '解释清楚易懂' },
    kindAsk: { bad: '答非所问，没答到点上', good: '正面回答了我的问题' },
    code: { bad: '代码/命令有错或有坑', good: '代码/命令可直接照做' },
    mapWrite: { bad: '写进导图后发现内容不合适', good: '落进导图的内容正合适' }
  };

  /**
   * 信号 → 候选（**纯函数**）。每条 `{text, signal}`，`signal` 就是产生它的信号名 ✓。
   * 顺序固定 len → kind → code → mapWrite（= DOM 里选项的先后）。
   * @param {{lenBucket?:string, kind?:string, hasCode?:boolean, mapWritten?:boolean}} sig
   * @param {number|null|undefined} stars 1–5；`>= 4` ⇒ 满意档，其余（含 null/0）⇒ 不满意档
   * @returns {Array<{text:string, signal:string}>}
   */
  function deriveFeedbackCandidates(sig, stars) {
    const s = sig || {};
    const pick = (pair) => (stars >= 4 ? pair.good : pair.bad);
    const out = [];
    if (s.lenBucket === 'long') out.push({ text: pick(TEXTS.lenLong), signal: 'len' });
    if (s.lenBucket === 'short') out.push({ text: pick(TEXTS.lenShort), signal: 'len' });
    if (s.kind === 'explain') out.push({ text: pick(TEXTS.kindExplain), signal: 'kind' });
    else out.push({ text: pick(TEXTS.kindAsk), signal: 'kind' });
    if (s.hasCode) out.push({ text: pick(TEXTS.code), signal: 'code' });
    if (s.mapWritten) out.push({ text: pick(TEXTS.mapWrite), signal: 'mapWrite' });
    return out.slice(0, ASK_FB_MAX_CANDIDATES);
  }

  return {
    ASK_FB_MAX_CANDIDATES: ASK_FB_MAX_CANDIDATES,
    SIGNALS: SIGNALS,
    LEN_SHORT_BELOW: LEN_SHORT_BELOW,
    LEN_LONG_ABOVE: LEN_LONG_ABOVE,
    collectAnswerSignals: collectAnswerSignals,
    deriveFeedbackCandidates: deriveFeedbackCandidates
  };
});
