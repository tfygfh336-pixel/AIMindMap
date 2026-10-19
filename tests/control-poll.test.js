/* ============================================================
 * tests/control-poll.test.js —— 界面侧轮询消费器（src/control-poll.js）单测
 * ------------------------------------------------------------
 * 为什么必须有这个文件（批 1 报告 ⑦-2 的两条实测缺陷都长在这里）：
 *   · **重复派发**：旧实现"取命令"是 `readCommand()`，而清命令要等异步工作做完 ——
 *     400ms 轮询在这中间会**再读一遍同一条命令**并再派发一次（`dsh-prefill` 的
 *     `show()` / `executeJavaScript` 各跑两遍，两遍还会抢同一个 webContents）。
 *   · **单槽覆盖**：两个 CLI 同时下命令时互相覆盖（那一条在 tests/control.test.js 里钉住）。
 *
 * 这一段逻辑原先内联在 `main.js` 里 ⇒ 要 Electron 才能加载 ⇒ **从来没有单测**，
 * 而"两个进程同时下命令 / 一条慢命令跨了好几拍"这种竞态**恰恰是跑一次看不出来的**。
 * 抽成 `src/control-poll.js` 之后，这里用**注入的 handle + 注入的时钟**确定性地复现：
 *   ① 慢命令跨多拍 ⇒ 只派发一次（这条是"重复派发"的直接判据）；
 *   ② 两条并发 ⇒ 各有各的回执，互不串；
 *   ③ `handle` 同步抛 ⇒ 当场给失败回执（不许让调用方等一个永远不来的东西）；
 *   ④ 同一个 token 回两次回执 ⇒ 只认第一次（后一次忽略并留日志）。
 * ⚠️ 判据一律读**盘上的回执文件**（真值），不是读桩里记下的调用次数 ——
 *    "回执写没写出去"才是调用方唯一能看见的东西 ✓
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);
const control = require(path.resolve(__dirname, '..', 'src', 'control.js'));
const { createControlPoller } = require(path.resolve(__dirname, '..', 'src', 'control-poll.js'));

/* ---------------- 临时目录：**收集每一个**，收尾一次删干净 ----------------
 * 病（2026-10-19 实测）：`tmp()` 在本文件里被 **7 个用例各调一次**（每个用例一个独立目录），
 * 旧实现只把"最后一个路径"留在变量里 ⇒ 其余 6 个永久留在 `%TEMP%`
 * （读数：一次 `npx vitest run tests/control-poll.test.js` ⇒ `%TEMP%` 里 `mm-control-poll-*` **+7**）。
 * ⇒ 现在**每次创建都登记**，删盘的唯一入口是 `afterAll(cleanupAll)`（没有别的 `fs.rmSync` 收尾）。
 * 清理的形态与语义（`recursive + force` = 550ed82 的教训 / 失败响亮但不判红 / 三态读数）**收在公共件**
 * `tests/_tmp-cleanup.js` —— 本文件只声明"用哪个前缀"，不再复制那 15 行。 */
const tmp = () => makeTmp('mm-control-poll-');
afterAll(cleanupAll);

/** 一个可控的"慢命令"：返回 { promise, resolve } —— 用来把"异步期间又轮询了一拍"写实 */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

describe('轮询消费器：一条命令至多被派发一次（治「400ms 轮询重复派发」）', () => {
  it('★ 慢命令跨了好几拍 ⇒ 只派发一次；异步期间再轮询也看不到它', async () => {
    const dir = tmp();
    const { token } = control.writeCommand(dir, { cmd: 'dsh-prefill', text: '只该跑一次' });
    const d = deferred();
    const logLines = [];
    const poller = createControlPoller({
      dir,
      log: (m) => logLines.push(m),
      // handle 故意**不马上**回复：这就是"异步命令还在干活"的现场
      handle: (claim, reply) => { d.promise.then((r) => reply(r)); return d.promise; }
    });

    expect(poller.pollOnce()).toEqual([token]);      // 第一拍：认领并派发
    // ★ 关键：异步还没结束，这时**再轮询 5 拍**（真实里就是 400ms × 5）
    for (let i = 0; i < 5; i++) expect(poller.pollOnce()).toEqual([]);
    expect(poller.dispatched.length).toBe(1);        // 派发历史里只有一条 = 没被重复派发
    expect(control.readResult(dir, token)).toBeNull();   // 还没回执（调用方此时应当继续等）

    d.resolve({ ok: true, result: { textLen: 6 } });     // 慢命令干完了
    await d.promise;
    await new Promise((r) => setImmediate(r));           // 让 reply 的 then 落地
    const r = control.readResult(dir, token);
    expect(r).toBeTruthy();
    expect(r.token).toBe(token);
    expect(r.result.textLen).toBe(6);
    expect(poller.pollOnce()).toEqual([]);               // 干完了也不会再派发同一 token
  });

  it('★ 两条并发命令各有各的回执（多槽 + 认领：谁也不覆盖谁、谁也不吃谁的回执）', () => {
    const dir = tmp();
    const a = control.writeCommand(dir, { cmd: 'dsh-prefill', text: 'A' });
    const b = control.writeCommand(dir, { cmd: 'dsh-prefill', text: 'B' });
    const seen = [];
    const poller = createControlPoller({
      dir,
      handle: (claim, reply) => { seen.push(claim.text); reply({ ok: true, result: { textLen: claim.text.length } }); }
    });
    const dispatched = poller.pollOnce();
    expect(dispatched.length).toBe(2);
    expect(dispatched.sort()).toEqual([a.token, b.token].sort());   // 两条都派发了（没有互相覆盖）
    expect(seen.sort()).toEqual(['A', 'B']);                        // 两条命令体各就各位
    // 回执按 token 认：A 的回执里 textLen 是 A 的，B 的是 B 的（两条同名命令不会串）
    expect(control.readResult(dir, a.token).result.textLen).toBe(1);
    expect(control.readResult(dir, b.token).result.textLen).toBe(1);
    expect(control.readResult(dir, a.token).token).toBe(a.token);
    expect(control.readResult(dir, b.token).token).toBe(b.token);
  });

  it('handle 同步抛（坏命令 / 未知命令）⇒ 当场写失败回执，**不让调用方白等一个窗口**', () => {
    const dir = tmp();
    const { token } = control.writeCommand(dir, { cmd: 'dsh-谁也不认识' });
    const logLines = [];
    const poller = createControlPoller({
      dir,
      log: (m) => logLines.push(m),
      handle: () => { throw new Error('界面不认识这条命令'); }
    });
    expect(poller.pollOnce()).toEqual([token]);
    const r = control.readResult(dir, token);
    expect(r).toBeTruthy();
    expect(r.ok).toBe(false);
    expect(r.err).toContain('界面不认识这条命令');   // 原因**原样**带回，不换成"没响应"
  });

  it('handle 返回被 reject 的 Promise ⇒ 同样写失败回执（异步失败不许变成静默）', async () => {
    const dir = tmp();
    const { token } = control.writeCommand(dir, { cmd: 'dsh-only', on: true });
    const poller = createControlPoller({ dir, handle: () => Promise.reject(new Error('关页失败')) });
    poller.pollOnce();
    await new Promise((r) => setImmediate(r));
    const r = control.readResult(dir, token);
    expect(r && r.ok).toBe(false);
    expect(r.err).toContain('关页失败');
  });

  it('同一个 token 回两次回执 ⇒ 只认第一次，并把"回了两次"记进日志', () => {
    const dir = tmp();
    const { token } = control.writeCommand(dir, { cmd: 'dsh-status' });
    const logLines = [];
    const poller = createControlPoller({
      dir,
      log: (m) => logLines.push(m),
      handle: (claim, reply) => { reply({ ok: true, status: { status: 'running' } }); reply({ ok: false, status: null }); }
    });
    poller.pollOnce();
    const r = control.readResult(dir, token);
    expect(r.ok).toBe(true);                          // 后一次没有把前一次覆盖掉
    expect(r.status.status).toBe('running');
    expect(logLines.join('\n')).toContain('回了两次回执');
  });

  it('pending 里读不出来的文件：当作"没有命令"丢掉，但**必须出声**（不静默）', () => {
    const dir = tmp();
    const p = control.paths(dir);
    control.writeCommand(dir, { cmd: 'dsh-status' });      // 建目录
    fs.writeFileSync(path.join(p.pending, 'broken.json'), '{ "cmd": "dsh-o', 'utf8');
    const logLines = [];
    let handled = 0;
    const poller = createControlPoller({
      dir,
      log: (m) => logLines.push(m),
      handle: (claim, reply) => { handled++; reply({ ok: true }); }
    });
    poller.pollOnce();
    expect(handled).toBe(1);                               // 只有那条好命令被派发
    expect(logLines.join('\n')).toContain('broken.json');  // 丢弃可见（排查现场靠它）
  });

  it('没有 dir 时停用（返回空且不抛）—— 调用方拿不到底层目录时必须能安全地不干活', () => {
    const poller = createControlPoller({ handle: () => { throw new Error('不该被调用'); } });
    expect(poller.pollOnce()).toEqual([]);
    expect(poller.start(400)).toBe(false);                 // 起不来就如实返回 false，不假装起来了
  });

  it('start 幂等：重复 start 不会起第二个定时器；stop 之后不再轮询', async () => {
    const dir = tmp();
    let handled = 0;
    const poller = createControlPoller({ dir, handle: (c, reply) => { handled++; reply({ ok: true }); } });
    expect(poller.start(20)).toBe(true);
    expect(poller.start(20)).toBe(false);                  // 已经是跑着的 ⇒ 不起第二个
    control.writeCommand(dir, { cmd: 'dsh-status' });
    await new Promise((r) => setTimeout(r, 120));
    expect(handled).toBe(1);
    expect(poller.stop()).toBe(true);
    control.writeCommand(dir, { cmd: 'dsh-status' });
    await new Promise((r) => setTimeout(r, 120));
    expect(handled).toBe(1);                               // 停了就是停了（不再有新派发）
  });
});
