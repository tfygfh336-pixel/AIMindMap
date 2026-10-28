/* ============================================================
 * tests/feed-seq-identity.test.js — 「同一条命令只追加一次、两条命令各一次」的**身份**判据
 * ------------------------------------------------------------
 * 治的是什么（代码可证，不是猜）：投喂台账（`main-dsh-sidebar.js` 的 `feedLedger`）早就实现了
 * "同一个 seq 只生效一次"，可 `feedSeqNo` 那句注释写着"只有调用方没给 seq 时才用"——
 * 而**调用方从来没给过**（`main.js` 的两个入口都是 `prefillComposer(text)`）⇒ 每次重试都由
 * 侧栏模块发新号 ⇒ 同一条命令被派发两次就插两遍（正是用户真机报的那个覆盖/重复缺陷）。
 *
 * 陷阱（本文件专门钉住它）：控制通道那条命令的身份是**字符串 token**，而 seq 的合法域是
 *   **有限正整数** ⇒ 把 token 直接当 seq 传会被判非法、**静默退回发新号**：接线看起来接上了，
 *   去重一次都没生效。所以这里同时钉三件事：
 *     ① 同一 token 换出的 seq **恒等**（⇒ 第二次派发被台账吞掉，n 只加一次）；
 *     ② 不同 token 换出的 seq **一定不同**（⇒ 两条命令各追加一次，防"永远只认第一个"）；
 *     ③ 反例：**把 token 当 seq 传**换不出恒等号（一次都不指望它去重）—— 这条让 ①② 不至于空转：
 *        如果哪天有人把换算退回"拿 token 当数字用"，③ 会立刻红。
 *
 * 走的是**产品那条路**（`prefillComposer` → 台账 → 文本兜底），只用测试接缝换掉
 *   "侧栏视图"与"服务在跑"两个外部条件（真页面那一半由冒烟域 30 用真 webContents 验）。
 * ============================================================ */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sidebar = require('../main-dsh-sidebar.js');

/** 假视图：只提供 `prefillComposerTextPath` 真正用到的那一点接口。
 *  页面侧真的把字插进去了没有 —— 那是冒烟域 30 的事（用真 webContents 跑同一份 COMPOSER_PREFILL_JS）。 */
function makeFakeView() {
  const calls = [];
  const view = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: (code) => {
        calls.push(String(code).slice(0, 40));
        // 文本兜底路径读的是 JSON 字符串里的 `ok`（见 main-dsh-sidebar.js 的 run.then）
        return Promise.resolve(JSON.stringify({ ok: true, mode: 'insertText', added: 2, addedLines: 2 }));
      }
    }
  };
  return { view, calls };
}

const BODY = '第一行文字\n第二行文字';        // 非 chip 形状 ⇒ 直接走文本兜底（不调页面做 chip）

beforeEach(() => {
  sidebar.__resetFeedStateForTest();
});

describe('投喂台账的身份：同一条命令一次、两条命令各一次', () => {
  it('① 同一条命令被派发两次 ⇒ 只追加一次（台账 n 只加一次、页面只被写一次）', async () => {
    const { view, calls } = makeFakeView();
    sidebar.__setFeedViewForTest(view, 'running');

    const a = await sidebar.prefillComposer(BODY, { token: 'cmd-1' });
    const totalAfterFirst = sidebar.feedLedgerTotal();
    const callsAfterFirst = calls.length;

    const b = await sidebar.prefillComposer(BODY, { token: 'cmd-1' });   // ← 同一条命令再来一次
    const totalAfterSecond = sidebar.feedLedgerTotal();

    expect(a.ok, '第一次应当真的写进去了').toBe(true);
    expect(b.ok).toBe(true);
    expect(b.already, '第二次必须判成"早就生效过"').toBe(true);
    expect(b.seq, '同一个 token 必须换出同一个 seq').toBe(a.seq);
    expect(totalAfterFirst, '第一次之后台账里应当有 2 行（BODY 两行）').toBe(2);
    expect(totalAfterSecond, '同一条命令派发两次，台账累计**不许**变成 4 —— 那是同一批投喂插了两遍')
      .toBe(2);
    expect(calls.length, '第二次一个字都不许写进页面').toBe(callsAfterFirst);
    expect(sidebar.feedLedgerView().seqs.length, '台账里只该有一条记录').toBe(1);
  });

  it('② 两条不同命令 ⇒ 各追加一次（防"永远只认第一个 seq"）', async () => {
    const { view, calls } = makeFakeView();
    sidebar.__setFeedViewForTest(view, 'running');

    const a = await sidebar.prefillComposer(BODY, { token: 'cmd-A' });
    const b = await sidebar.prefillComposer(BODY, { token: 'cmd-B' });   // ← 另一条命令

    expect(a.seq).not.toBe(b.seq);
    expect(b.already, '不同命令不许被当成同一条').toBe(false);
    expect(sidebar.feedLedgerTotal(), '两条命令各 2 行 ⇒ 累计 4').toBe(4);
    expect(sidebar.feedLedgerView().seqs.length).toBe(2);
    expect(calls.length, '页面被写两次').toBe(2);
  });

  it('③ 反例（让 ①② 不空转）：**把 token 当 seq 传**换不出恒等号 ⇒ 那一档根本不去重', async () => {
    // 这是接线最容易掉进去的坑：token 是字符串，seq 的合法域是有限正整数
    const n1 = sidebar.feedSeqFor({ token: 'cmd-X' });
    const n2 = sidebar.feedSeqFor({ token: 'cmd-X' });
    expect(Number.isInteger(n1) && n1 > 0, 'token 换出来的必须是**有限正整数**（台账按 === 认）').toBe(true);
    expect(n2, '同一 token 必须恒等').toBe(n1);

    // 陷阱本身：把 token 直接塞进 seq ⇒ 判非法 ⇒ 退回发新号 ⇒ 每次派发一个新号
    const bad1 = sidebar.feedSeqFor({ seq: 'cmd-X' });
    const bad2 = sidebar.feedSeqFor({ seq: 'cmd-X' });
    expect(Number.isInteger(bad1)).toBe(true);         // 仍是"合法 seq"（因为退回发号了）
    expect(bad1).not.toBe(n1);                          // 但**不是**那个恒等号
    expect(bad2).not.toBe(bad1);                        // 而且两次还不一样 ⇒ 台账吞不掉
  });

  it('④ 没给身份 ⇒ 每次都是新意图（拿到的号互不相同）；显式给 seq ⇒ 逐字沿用', async () => {
    const { view } = makeFakeView();
    sidebar.__setFeedViewForTest(view, 'running');

    const a = await sidebar.prefillComposer(BODY);
    const b = await sidebar.prefillComposer(BODY);      // 界面点两次 = 两次新意图
    expect(a.seq).not.toBe(b.seq);
    expect(sidebar.feedLedgerTotal(), '两次新意图各 2 行').toBe(4);

    // 显式 seq：重试沿用同一个（老调用方那一档，行为逐字不变）
    const c = await sidebar.prefillComposer(BODY, { seq: 999 });
    const d = await sidebar.prefillComposer(BODY, { seq: 999 });
    expect(c.seq).toBe(999);
    expect(d.already).toBe(true);
    expect(sidebar.feedLedgerTotal(), '第三次/第四次不该再加').toBe(6);
  });
});
