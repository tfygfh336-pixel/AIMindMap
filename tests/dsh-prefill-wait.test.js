/* ============================================================
 * tests/dsh-prefill-wait.test.js — `dsh-prefill` 的等待口径（D5）
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
 * 这里不真的等 14s：骨架被抽成 `runAfterLivenessProbe(wait, send, …)`（`wait`/`send` 可注入），
 *   分支用假 wait 覆盖；真轮询只跑"界面没在跑"这一条，并断言它**显著快于旧窗口**。
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

describe('waitForResult：只认对应命令的**新鲜**回执', () => {
  it('目录里有对应回执 ⇒ 立刻返回（不等满窗口）', () => {
    const d = tmpDir();
    control.writeResult(d, { cmd: 'dsh-prefill', ok: true, at: new Date().toISOString() });
    const t0 = Date.now();
    const r = waitForResult(d, 'dsh-prefill', 2000);
    expect(r).toBeTruthy();
    expect(r.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('陈旧回执（超出窗口+余量）不算 —— 本机事故：4.5 小时前的旧回执被当成实时结果', () => {
    const d = tmpDir();
    control.writeResult(d, { cmd: 'dsh-prefill', ok: true, at: new Date(Date.now() - 4.5 * 3600 * 1000).toISOString() });
    expect(waitForResult(d, 'dsh-prefill', 300)).toBeNull();
  });

  it('别的命令的回执不算（cmd 必须对上）', () => {
    const d = tmpDir();
    control.writeResult(d, { cmd: 'dsh-status', ok: true, at: new Date().toISOString() });
    expect(waitForResult(d, 'dsh-prefill', 300)).toBeNull();
  });
});

describe('两步式骨架（注入假 wait/send ⇒ 零等待覆盖全部分支）', () => {
  /** steps：按调用顺序返回的回执；calls：记录每次等待的 (cmd, ms) */
  const trace = (steps, calls) => (dir, cmd, ms) => {
    calls.push({ cmd, ms });
    return steps.shift() || null;
  };
  const counter = () => { const c = { n: 0 }; return { c, fn: () => { c.n++; } }; };

  it('探活失败 ⇒ phase=not-running：**探针命令发了**，但**慢命令根本没发出**（不留下将来会被执行的命令）', () => {
    const calls = [];
    const probe = counter(), slow = counter();
    const r = runAfter(probe.fn, trace([null], calls), slow.fn, '/x', 'dsh-status', 'dsh-prefill');
    expect(r.phase).toBe('not-running');
    expect(r.receipt).toBeNull();
    expect(probe.c.n).toBe(1);                 // ★ 探针必须真的写出去（这条是修一个真 bug：漏写探针 ⇒ 永远探活失败）
    expect(slow.c.n).toBe(0);
    expect(calls).toEqual([{ cmd: 'dsh-status', ms: ACK_MS }]);
  });

  it('探活成功 ⇒ 才下慢命令，并用 PREFILL_MS 等结果（足够让界面干完活）', () => {
    const calls = [];
    const probe = counter(), slow = counter();
    const final = { cmd: 'dsh-prefill', ok: true, at: new Date().toISOString() };
    const r = runAfter(probe.fn, trace([{ cmd: 'dsh-status', ok: true }, final], calls), slow.fn,
      '/x', 'dsh-status', 'dsh-prefill');
    expect(probe.c.n).toBe(1);
    expect(slow.c.n).toBe(1);
    expect(r.phase).toBe('final');
    expect(r.receipt).toBe(final);
    expect(calls.map((c) => c.cmd)).toEqual(['dsh-status', 'dsh-prefill']);
    expect(calls[1].ms).toBe(PREFILL_MS);
  });

  it('探活成功但慢命令无回执 ⇒ phase=no-receipt（**与 not-running 必须分开**：建议完全不同）', () => {
    const calls = [];
    const r = runAfter(() => {}, trace([{ cmd: 'dsh-status', ok: true }, null], calls), () => {}, '/x', 'dsh-status', 'dsh-prefill');
    expect(r.phase).toBe('no-receipt');
    expect(r.receipt).toBeNull();
  });

  it('界面拒绝了（有回执但 ok:false）⇒ 失败原因**原样带回**，不被吞掉也不被换成"没响应"', () => {
    const calls = [];
    const final = { cmd: 'dsh-prefill', ok: false, err: '页面找不到可见的输入框', at: new Date().toISOString() };
    const r = runAfter(() => {}, trace([{ cmd: 'dsh-status', ok: true }, final], calls), () => {}, '/x', 'dsh-status', 'dsh-prefill');
    expect(r.phase).toBe('final');
    expect(r.receipt.ok).toBe(false);
    expect(r.receipt.err).toBe('页面找不到可见的输入框');
  });

  it('不传探针（probeCmd 为空）时退化为单步，且不会多余地发探针命令', () => {
    const calls = [];
    const probe = counter(), slow = counter();
    const r = runAfter(probe.fn, trace([{ cmd: 'dsh-prefill', ok: true }], calls), slow.fn, '/x', null, 'dsh-prefill', 5000);
    expect(probe.c.n).toBe(0);
    expect(slow.c.n).toBe(1);
    expect(r.phase).toBe('final');
    expect(calls).toEqual([{ cmd: 'dsh-prefill', ms: 5000 }]);
  });
});

describe('真实轮询（界面没在跑：空目录）—— 判别力：显著快于旧窗口 12s', () => {
  it('探活落空即 not-running，且总耗时远小于旧窗口（修前实测 12.56s）', () => {
    const d = tmpDir();
    const t0 = Date.now();
    const r = runAfter(() => {}, waitForResult, () => {}, d, 'dsh-status', 'dsh-prefill');
    const ms = Date.now() - t0;
    expect(r.phase).toBe('not-running');
    expect(ms).toBeGreaterThanOrEqual(ACK_MS - 50);    // 确实等满了探活窗口（不是没等就报错）
    expect(ms).toBeLessThan(6000);                     // 旧实现会是 ~12.5s ⇒ 这条会红
  }, 20000);
});
