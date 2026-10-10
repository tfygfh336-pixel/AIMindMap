/* ============================================================
 * tests/dsh-prefill-wait.test.js — `dsh-prefill` 的等待口径（D5）与多槽 token（C）
 * ------------------------------------------------------------
 * 修前实测（2026-10-10 本机；`APPDATA` 指向空目录 = 界面没在跑）：
 *   dsh-status 3.07s ｜ dsh-sidebar off 3.03s ｜ sidebar-only off 3.08s ｜ **dsh-prefill 12.56s**
 * 根因（源码级）：`cli/commands/ui.js` 只有这一条用了 12s 窗口（另三条是 2.5s），
 *   而等待是"轮询到窗口用完为止"⇒ 界面没在跑时，那 12s 全花在等一个**永远不会来**的回执上。
 * 同源的第二个缺陷：app 侧最坏路径 ≈12.4s > 旧窗口 12s ⇒ 界面**还在干活**时 CLI 就报
 *   "主界面没有响应…请确认在运行" ——**假原因**（界面在跑、可能马上就成功）。
 *
 * 修法（两步式）：先用**只读探针** `dsh-status` 探活（当场可答、没有慢路径），
 *   探活失败 ⇒ 立刻报"没在运行"（有证据，且**不发出**慢命令）；
 *   探活成功 ⇒ 下慢命令，给足 PREFILL_MS（> app 侧最坏路径）。
 *
 * ⚠️ 本文件后来又被 C 改过一次：回执改为**按 token 认**（多槽协议）。
 *   于是这里的注入桩也换成 `(dir, token, ms)` 形状 —— 断言同时钉住"发出去的命令**带对了 token**"
 *   这条（批 1 的教训：只等回执不断言"命令真的写出去过"，是抓不到"漏发探针"这类缺陷的 ✗）。
 * ============================================================ */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ui = require('../cli/commands/ui.js');
const control = require('../src/control.js');
const { __waitForResult: waitForResult, __runAfterLivenessProbe: runAfter, __UI_ACK_MS: ACK_MS, __PREFILL_MS: PREFILL_MS } = ui;

const dirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-prefill-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) { try { fs.rmSync(dirs.pop(), { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

describe('窗口常量：覆盖 app 侧最坏路径，且探活窗口与另三条命令同口径', () => {
  it('探活窗口 ≤ 另三条命令的 2.5s（界面没在跑时不该比它们慢）', () => {
    expect(ACK_MS).toBeLessThanOrEqual(2500);
  });

  it('慢命令窗口 > app 侧最坏路径 12.4s（起服务 ≤6s + 加宽 0.4s + executeJavaScript ≤6s）', () => {
    // 旧值 12s < 12.4s ⇒ 界面还在干活就被判"没响应"（假原因）。这条断言把这个余量钉死。
    expect(PREFILL_MS).toBeGreaterThan(12400);
  });
});

describe('waitForResult：只认自己那个 token 的**新鲜**回执', () => {
  it('目录里有自己 token 的回执 ⇒ 立刻返回（不等满窗口）', () => {
    const d = tmpDir();
    const token = control.newToken('t');
    control.writeResult(d, token, { cmd: 'dsh-prefill', ok: true, at: new Date().toISOString() });
    const t0 = Date.now();
    const r = waitForResult(d, token, 2000);
    expect(r).toBeTruthy();
    expect(r.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('★ 别人的 token 不算（多槽的核心：两条同名命令并发时不许互相吃到对方的回执）', () => {
    const d = tmpDir();
    const mine = control.newToken('t'), other = control.newToken('t');
    control.writeResult(d, other, { cmd: 'dsh-prefill', ok: true, at: new Date().toISOString() });
    expect(waitForResult(d, mine, 300)).toBeNull();
  });

  it('同名命令 + 同窗口：两条各自拿到**自己那条**回执（token 不串）', () => {
    const d = tmpDir();
    const a = control.newToken('a'), b = control.newToken('b');
    control.writeResult(d, b, { ok: true, result: { textLen: 2 }, at: new Date().toISOString() });
    control.writeResult(d, a, { ok: true, result: { textLen: 1 }, at: new Date().toISOString() });
    expect(waitForResult(d, a, 500).result.textLen).toBe(1);
    expect(waitForResult(d, b, 500).result.textLen).toBe(2);
  });

  it('陈旧回执（超出窗口+余量）不算 —— 本机事故：4.5 小时前的旧回执被当成实时结果', () => {
    const d = tmpDir();
    const token = control.newToken('t');
    control.writeResult(d, token, { ok: true, at: new Date(Date.now() - 4.5 * 3600 * 1000).toISOString() });
    expect(waitForResult(d, token, 300)).toBeNull();
  });
});

describe('两步式骨架（注入假 probe/wait/send ⇒ 零等待覆盖全部分支）', () => {
  /** steps：按调用顺序返回的回执；calls：记录每次等待的 (token, ms)；sent：记录发出去的命令 */
  const trace = (steps, calls) => (dir, token, ms) => {
    calls.push({ token, ms });
    return steps.shift() || null;
  };
  /** 一个假的"调用方写入"：断言**命令真的被写出去过**（批 1 教训 ⇒ 不许只等回执） */
  const recorder = (sent) => (token) => { sent.push(token); };

  it('探活失败 ⇒ phase=not-running：**探针命令发了**，但**慢命令根本没发出**（不留下将来会被执行的命令）', () => {
    const calls = [];
    const sentProbe = [], sentSlow = [];
    const r = runAfter(recorder(sentProbe), trace([null], calls), recorder(sentSlow), '/x', 'dsh-status', 'dsh-prefill');
    expect(r.phase).toBe('not-running');
    expect(r.receipt).toBeNull();
    expect(sentProbe.length).toBe(1);              // ★ 探针必须真的写出去（这条是修一个真 bug：漏写探针 ⇒ 永远探活失败）
    expect(sentSlow.length).toBe(0);
    expect(calls).toEqual([{ token: r.token, ms: ACK_MS }]);
  });

  it('探活成功 ⇒ 才下慢命令，并用 PREFILL_MS 等结果（足够让界面干完活）；**两条命令同一个 token**', () => {
    const calls = [];
    const sentProbe = [], sentSlow = [];
    const final = { ok: true, at: new Date().toISOString() };
    const r = runAfter(recorder(sentProbe), trace([{ ok: true }, final], calls), recorder(sentSlow),
      '/x', 'dsh-status', 'dsh-prefill');
    expect(sentProbe.length).toBe(1);
    expect(sentSlow.length).toBe(1);
    expect(sentSlow[0]).toBe(sentProbe[0]);       // 同一个调用方 = 同一个等待位（回执不会串 ✓）
    expect(r.token).toBe(sentSlow[0]);
    expect(r.phase).toBe('final');
    expect(calls.map((c) => c.ms)).toEqual([ACK_MS, PREFILL_MS]);
  });

  it('探活成功但慢命令无回执 ⇒ phase=no-receipt（**与 not-running 必须分开**：建议完全不同）', () => {
    const calls = [];
    const r = runAfter(() => {}, trace([{ ok: true }, null], calls), () => {}, '/x', 'dsh-status', 'dsh-prefill');
    expect(r.phase).toBe('no-receipt');
    expect(r.receipt).toBeNull();
  });

  it('界面拒绝了（有回执但 ok:false）⇒ 失败原因**原样带回**，不被吞掉也不被换成"没响应"', () => {
    const calls = [];
    const final = { ok: false, err: '页面找不到可见的输入框', at: new Date().toISOString() };
    const r = runAfter(() => {}, trace([{ ok: true }, final], calls), () => {}, '/x', 'dsh-status', 'dsh-prefill');
    expect(r.phase).toBe('final');
    expect(r.receipt.ok).toBe(false);
    expect(r.receipt.err).toBe('页面找不到可见的输入框');
  });

  it('不传探针（probeCmd 为空）时退化为单步，且不会多余地发探针命令', () => {
    const calls = [];
    const sentProbe = [], sentSlow = [];
    const r = runAfter(recorder(sentProbe), trace([{ ok: true }], calls), recorder(sentSlow), '/x', null, 'dsh-prefill', 5000);
    expect(sentProbe.length).toBe(0);
    expect(sentSlow.length).toBe(1);
    expect(r.phase).toBe('final');
    expect(calls).toEqual([{ token: r.token, ms: 5000 }]);
  });
});

describe('★ 真实往返（真写命令文件、真等回执）—— 判别力：漏发探针 / token 串了都必红', () => {
  it('★ 真链路：**命令文件先落盘**（可被界面读到）→ 界面写回执 → CLI 拿到 ✓', () => {
    const d = tmpDir();
    let sawCmd = null;
    const r = runAfter(
      // 探针：**真的写进 pending**（这就是"发出去了"的证据 —— 批 1 的教训）
      (token) => { control.writeCommand(d, { cmd: 'dsh-status', token: token }); },
      // 第一拍：读 pending 断言探针真的在盘上（不是只记了个 flag），再当场写它的回执
      (dir, token, ms) => {
        if (!sawCmd) {
          sawCmd = control.listPending(dir).find((c) => c.token === token) || null;
          control.writeResult(dir, token, { ok: true, status: { status: 'running' }, at: new Date().toISOString() });
          return { ok: true, status: { status: 'running' }, at: new Date().toISOString() };
        }
        // 第二拍：慢命令也必须真的在盘上（且带同样的文本）
        const slowCmd = control.listPending(dir).find((c) => c.token === token) || null;
        expect(slowCmd).toBeTruthy();
        expect(slowCmd.cmd).toBe('dsh-prefill');
        expect(slowCmd.text).toBe('要送过去的文本');
        control.writeResult(dir, token, { ok: true, cmd: 'dsh-prefill',
          result: { ok: true, tag: 'TEXTAREA', textLen: 6 }, at: new Date().toISOString() });
        return { ok: true, cmd: 'dsh-prefill', result: { ok: true, tag: 'TEXTAREA', textLen: 6 },
          at: new Date().toISOString() };
      },
      (token) => { control.writeCommand(d, { cmd: 'dsh-prefill', text: '要送过去的文本', token: token }); },
      d, 'dsh-status', 'dsh-prefill', 3000);
    expect(sawCmd).toBeTruthy();
    expect(sawCmd.cmd).toBe('dsh-status');       // ★ 探针命令**真的写出去了**（漏发 ⇒ 这条必红）
    expect(r.phase).toBe('final');
    expect(r.receipt.ok).toBe(true);
    expect(r.receipt.result.tag).toBe('TEXTAREA');
  });

  it('真实轮询（界面没在跑：空目录）—— 判别力：显著快于旧窗口 12s', () => {
    const d = tmpDir();
    const t0 = Date.now();
    const r = runAfter(() => {}, waitForResult, () => {}, d, 'dsh-status', 'dsh-prefill');
    const ms = Date.now() - t0;
    expect(r.phase).toBe('not-running');
    expect(ms).toBeGreaterThanOrEqual(ACK_MS - 50);    // 确实等满了探活窗口（不是没等就报错）
    expect(ms).toBeLessThan(6000);                     // 旧实现会是 ~12.5s ⇒ 这条会红
  }, 20000);
});
