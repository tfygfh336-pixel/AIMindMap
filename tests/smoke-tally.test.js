/* ============================================================
 * tests/smoke-tally.test.js — 冒烟结果的**三态计数**（`scripts/smoke-assertions.js` 的 `tally()`）
 *                              + 第三态在 `main.js` 里**真的被接上**（接线检查）
 *                              + 域 39 的环境探针**真的独立于产品链路**（接线检查）
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 为什么需要这个文件（三件都是"没有机械判据就会静默退化"的东西）：
 *   ① **计数口径只能有一处**（`tally()`）。它决定的三个数（通过 / 总数 / 未验证）是**读数**，
 *      不是样式：把"未验证"错算成通过 ⇒ 环境问题被洗白；错算成失败 ⇒ 环境问题冒充产品缺陷。
 *      两条都是"看着绿/看着红、其实结论是错的"，所以判定逻辑必须是**可单测的纯函数**（`B6`）。
 *   ② **第三态必须真的被 `main.js` 用上**：断言返回了一个 `unverified` 但 runner 不认，
 *      那条结果就会落回"PASS"（**比不打标记更危险**）⇒ 源码级接线检查钉住打印、计数与"不阻断"。
 *   ③ **环境探针必须独立于产品那条链**：域 39 的探针一旦改成"走产品自己的 IPC"，探针与判据就共用
 *      同一个失效源 —— 产品一回归、探针跟着坏，**真回归会被洗成"环境问题"（未验证）** ✗。
 *      ⇒ 机械检查探针函数体里不出现产品链路的任何入口（IPC 通道名 / preload 桥 / `desktop.app`）。
 *
 * ⚠️ 本文件里的源码级检查**先证明过会红**（判别力证明，做法与报文见交付说明 / `B4`）：
 *    改坏 `main.js` 的 `[未验证]` 标记 ⇒ ①②必红；把探针改成走产品链路 ⇒ ③必红。撤销后复绿。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const smoke = require('../scripts/smoke-assertions.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const domainSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'smoke', '39-item-detail.js'), 'utf8');

/** 从源码里切出一个函数的**函数体**（纯文本，够用且不引入解析器）。
 *  ⚠️ 切不到时**返回 null**，调用方必须显式断言非空 —— 否则"签名改了"会变成"检查恒真"（`B4` ③）。 */
function sliceFn(src, signature) {
  const i = String(src).indexOf(signature);
  if (i < 0) return null;
  const j = String(src).indexOf('\n}', i);
  return String(src).slice(i, j < 0 ? String(src).length : j);
}

describe('tally()：三档计数（通过 / 失败 / 未验证），未验证**不进"通过/总数"**', () => {
  it('判定档数 = 3：一份真实形状的结果被分成三档，不把它们压成一个数（`B4c`）', () => {
    const r = smoke.tally([
      { ok: true, text: '通过的那条' },
      { ok: false, text: '失败的那条' },
      { ok: true, unverified: '剪贴板本项未验证（环境：系统剪贴板不可用）', text: '未验证的那条' }
    ]);
    expect(r.passed).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.unverified).toBe(1);
    expect(r.total).toBe(2);                 // **关键**：未验证不进总数（"从总条数里分出去"）
    expect(r.unverifiedList).toEqual(['剪贴板本项未验证（环境：系统剪贴板不可用）']);
  });

  it('判别力：把"未验证"天真地当成通过（旧口径）⇒ 三个数与它不一样（这条计数真的在分辨）', () => {
    const rows = [
      { ok: true, text: '' }, { ok: true, text: '' },
      { ok: true, unverified: '环境坏', text: '' }
    ];
    const naivePassed = rows.filter((x) => x.ok).length;    // = 3（旧口径：ok 就算通过）
    const t = smoke.tally(rows);
    expect(naivePassed).toBe(3);
    expect(t.passed).toBe(2);
    expect(t.total).toBe(2);
    expect(t.passed).not.toBe(naivePassed);
  });

  it('fail-safe：「未验证」只许出现在通过的结果上；同时报失败 ⇒ **按失败计**（不许掩盖真失败）', () => {
    const r = smoke.tally([{ ok: false, unverified: '环境坏', text: '' }]);
    expect(r.failed).toBe(1);
    expect(r.unverified).toBe(0);            // ← 不许被算成"未验证"（那会给真失败开后门）
    expect(r.total).toBe(1);
    expect(r.unverifiedList).toEqual([]);
  });

  it('边界：`unverified` 必须是**非空字符串**才算未验证（空串 / true / 对象都不算）', () => {
    const r = smoke.tally([
      { ok: true, unverified: '', text: '' },
      { ok: true, unverified: true, text: '' },
      { ok: true, unverified: { why: 'x' }, text: '' }
    ]);
    expect(r.passed).toBe(3);
    expect(r.unverified).toBe(0);
  });

  it('边界：空数组 / 非数组 / 缺 ok ⇒ 不抛，且按 `!!ok` 与 runner 同一口径（缺 ok = 失败）', () => {
    expect(smoke.tally([])).toEqual({ passed: 0, failed: 0, unverified: 0, total: 0, unverifiedList: [] });
    expect(smoke.tally(null).total).toBe(0);
    // `!!ok`：与 `main.js` 里 `results.push({ ok: !!r.ok })` 同一口径（truthy 即通过）
    expect(smoke.tally([{}, undefined, { ok: 'yes' }]))
      .toEqual({ passed: 1, failed: 2, unverified: 0, total: 3, unverifiedList: [] });
  });
});

describe('接线检查：`main.js` 真的接上了第三态（打印 / 计数 / 不阻断）', () => {
  it('断言循环把 `unverified` 收进结果，且"既报未验证又报失败"时按失败计并响亮报出', () => {
    expect(mainSrc).toMatch(/let unv = \(r && typeof r === 'object' && typeof r\.unverified === 'string'/);
    expect(mainSrc).toContain('results.push({ name: a.name, ok: !!r.ok, text: String(r.text || \'\'), unverified: unv })');
    expect(mainSrc).toContain('按失败计');                 // fail-safe 的**响亮**分支
  });

  it('结果行有第三种标记 `[未验证]`，并且**另起一行**打 `[smoke]` 响亮行', () => {
    expect(mainSrc).toContain("(r.unverified ? '未验证' : (r.ok ? 'PASS' : 'FAIL'))");
    expect(mainSrc).toMatch(/if \(r\.unverified\) console\.log\('\[smoke\] ' \+ r\.unverified\)/);
  });

  it('计数走 `tally()`（未验证不进分子分母），且汇总行把"通过 / 总数 / 未验证"三个数**都贴出来**', () => {
    expect(mainSrc).toMatch(/const tally = allAssertions\.tally;/);
    expect(mainSrc).toMatch(/const smokeT = tally\(results\);/);
    expect(mainSrc).toMatch(/const seg = tally\(results\.slice\(from, to\)\);/);   // part() 也别自己数一份
    expect(mainSrc).toContain('const failed = results.filter((r) => !r.ok);');     // 未验证是 ok:true ⇒ 不阻断
    expect(mainSrc).toContain('冒烟三态：通过 ');
    expect(mainSrc).toContain("' ｜ 未验证 ' + smokeT.unverified");
  });

  it('取景记录（smoke-frame.json）带上未验证条数：槽位数 ≠ 这一轮判过的条数', () => {
    expect(mainSrc).toContain('smokeUnverified: smokeT.unverified,');
  });
});

describe('接线检查：域 39 的环境探针**独立于产品链路**（探针与判据不许共用失效源）', () => {
  const body = sliceFn(domainSrc, 'async function clipboardEnvProbe()');

  it('探针函数切得出来（切不到 ⇒ 这条检查本身失效，判红）', () => {
    expect(body, '在 scripts/smoke/39-item-detail.js 里找不到 `async function clipboardEnvProbe()`'
      + ' —— 签名改了就要同步改这里（否则下面几条会变成恒真 ✗）').toBeTruthy();
  });

  it('它用的是本进程直接的 writeText→readText 往返（真读数，不是常量）', () => {
    expect(body).toContain('electronClipboard.writeText(token)');
    expect(body).toContain('await readClip()');
    expect(body).toContain('back.text !== token');
  });

  it('它**不出现**产品那条链的任何入口（IPC 通道 / preload 桥 / desktop.app）', () => {
    ['clipboard-write', 'writeClipboard', 'ipcRenderer', 'desktop.app', 'window.desktop',
      'sendInputEvent', 'execCommand'].forEach((bad) => {
      expect(body, '探针里出现了产品链路的入口「' + bad + '」⇒ 探针与判据共用失效源：'
        + '产品一回归，探针跟着坏，**真回归会被洗成"环境问题"（未验证）** ✗').not.toContain(bad);
    });
  });
});
