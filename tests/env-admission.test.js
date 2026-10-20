/* ============================================================
 * tests/env-admission.test.js —— 环境准入门禁（`R1d` 的子项）的契约 + **判别力**
 * 运行：node node_modules/vitest/vitest.mjs run tests/env-admission.test.js --pool=threads
 * ------------------------------------------------------------
 * 为什么这个文件存在（`G-08`）：
 *   本工程原本只有**一条**内存相关的代码 —— `scripts/verify.js` 把 `os.freemem()` 记进
 *   `.review/verify-history.jsonl` 的 `freeMemMB` 字段（那句注释写的是"同一份代码、结果不同时
 *   最先要排除的变量"）。**没有任何判据读它。** 于是"环境差到根本不该跑"这件事没有出口：
 *   只能眼睁睁看 G5（唯一真起 Electron 的步骤）跑出**假红 / 超时** —— 而假红的下场是连真红也不看。
 *   本文件钉住的就是这条判据的边界：**什么条件下放行、什么条件下拒绝、什么条件下判红**，
 *   以及报文为什么能教下一个人怎么办（`R1d` 的 ①②③ 三条形态）。
 *
 * ## 被测面（全部是纯函数 —— 不碰 `os` / `process.env` / 不写盘）
 *   · `scripts/smoke-assertions.js`：`ENV_ADMISSION`（常量单源）+ `checkEnvAdmission(input)`（判定本体）；
 *   · `scripts/verify.js`：`envAdmittedLine` / `envRefusalLines` / `envRefusedRow`（报文与结果行）
 *     + `buildVerifyHistory`（拒绝这件事**必须落盘可区分**，否则记录里"环境拒绝"与"产品红"长一样）。
 *
 * ## 三条纪律（照本工程既有测试的形状）
 *   ① **红的方向要能分辨**：`ok:false`（判据没成立）与 `ok:true, admitted:false`（准入拒绝）是
 *      **两件不同的事**（前者=采不到真值⇒红，后者=环境不够⇒拒绝跑）⇒ 每条用例都断言具体字段，
 *      不只看一个布尔。
 *   ② **阈值不在测试里另写一份**：一律引用 `ENV_ADMISSION.minFreeMemMB`（阈值单源）；
 *      要测边界就 `minMB - 1` / `minMB`，不写字面量。
 *   ③ **接线也要钉**：判定对了但"没接上"等于没做（本工程最重的损害类别）⇒ 最后一组直接读
 *      `scripts/verify.js` 的源码，钉住"G5 之前确实调了它""拒绝时用别的退出码"。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const smoke = require('../scripts/smoke-assertions.js');
const verify = require('../scripts/verify.js');
const { checkEnvAdmission, ENV_ADMISSION } = smoke;
const verifySrc = fs.readFileSync(path.join(ROOT, 'scripts', 'verify.js'), 'utf8');
const rulesSrc = fs.readFileSync(path.join(ROOT, 'docs', 'RULES.md'), 'utf8');

/* ============================================================
 * ① 常量：阈值单源 + 拒绝码必须与"产品红"区分开
 * ============================================================ */
describe('环境准入：常量（阈值与退出码都只有一处权威）', () => {
  it('`ENV_ADMISSION` 的形状：门槛是正整数、开关名与退出码都在', () => {
    expect(Number.isInteger(ENV_ADMISSION.minFreeMemMB)).toBe(true);
    expect(ENV_ADMISSION.minFreeMemMB).toBeGreaterThan(0);
    expect(typeof ENV_ADMISSION.minVar).toBe('string');
    expect(ENV_ADMISSION.minVar.length).toBeGreaterThan(0);
    expect(Number.isInteger(ENV_ADMISSION.refusedExitCode)).toBe(true);
  });

  it('★ 拒绝码 **≠ 1**：\"没跑\"与\"跑了但失败\"在退出码上必须能分辨（`R1d` ①）', () => {
    expect(ENV_ADMISSION.refusedExitCode).not.toBe(1);
    expect(ENV_ADMISSION.refusedExitCode).toBeGreaterThan(1);
  });

  it('常量是冻结的（顺手改门槛的路只留"改源码 + CHANGELOG 留痕"这一条）', () => {
    expect(Object.isFrozen(ENV_ADMISSION)).toBe(true);
  });
});

/* ============================================================
 * ② 判定本体：放行 / 拒绝 / 判据不成立（三种出口，逐一出用例）
 * ============================================================ */
describe('`checkEnvAdmission`：三档出口', () => {
  const min = ENV_ADMISSION.minFreeMemMB;

  it('内存充足 ⇒ 放行（admitted:true、ok:true、读数原样带回）', () => {
    const r = checkEnvAdmission({ freeMB: min * 4 });
    expect(r).toMatchObject({ ok: true, admitted: true, minMB: min, override: false });
    expect(r.freeMB).toBe(Math.round(min * 4));
    expect(r.reason).toBe('');
  });

  it('★ 恰好等于门槛 ⇒ **放行**（判据是 `<`，不是 `<=` —— 边界不许模糊）', () => {
    expect(checkEnvAdmission({ freeMB: min }).admitted).toBe(true);
  });

  it('★ 低于门槛 1 MB ⇒ **拒绝**（ok:true + admitted:false ⇒ 这不是"判据失效"，是"环境不够"）', () => {
    const r = checkEnvAdmission({ freeMB: min - 1 });
    expect(r.ok).toBe(true);            // 判据成立（算得出来）
    expect(r.admitted).toBe(false);     // 结论是拒绝
    expect(r.reason).toContain(String(min));
    expect(r.reason).toContain(String(min - 1));
  });

  it('★ 采不到可用内存（NaN / undefined / 0 / 负数）⇒ **ok:false**（采不到真值 = 红，不许当放行）', () => {
    [NaN, undefined, null, 0, -1, Infinity, 'x'].forEach((v) => {
      const r = checkEnvAdmission({ freeMB: v });
      expect(r.ok, 'freeMB=' + String(v) + ' 必须判红').toBe(false);
      expect(r.admitted).toBe(false);
      expect(r.reason).toContain('采不到');
    });
  });

  it('`input` 整个不给 ⇒ 按"采不到真值"处理（不许因为少传一个对象就放行）', () => {
    const r = checkEnvAdmission();
    expect(r.ok).toBe(false);
    expect(r.admitted).toBe(false);
  });

  it('★ `ok:false` 时 `admitted` 恒 false（两者不许组合出\"判据失效但放行\"）', () => {
    [[NaN], [123, 'abc']].forEach(([freeMB, rawMin]) => {
      const r = checkEnvAdmission({ freeMB: freeMB, rawMin: rawMin });
      expect(r.ok).toBe(false);
      expect(r.admitted).toBe(false);
    });
  });
});

/* ============================================================
 * ③ 门槛覆盖开关：能改小，但**非法值必须判红**（静默落回默认 = "你以为它生效了，其实没有"）
 * ============================================================ */
describe('门槛覆盖 `' + 'MM_MIN_FREE_MEM_MB' + '`', () => {
  it('显式设成更小的正整数 ⇒ 放行，且 `override:true`（调用方据此打印"改小过"）', () => {
    const r = checkEnvAdmission({ freeMB: 10, rawMin: '1' });
    expect(r).toMatchObject({ ok: true, admitted: true, minMB: 1, override: true });
  });

  it('设成比默认**大**也照用（收紧方向同样允许）', () => {
    const r = checkEnvAdmission({ freeMB: 10, rawMin: '999999' });
    expect(r).toMatchObject({ ok: true, admitted: false, minMB: 999999, override: true });
  });

  it('★ 非法值（`abc` / `0` / `-5` / `1.5` / `true`）⇒ **ok:false**（红），绝不静默落回默认门槛', () => {
    ['abc', '0', '-5', '1.5', 'true'].forEach((v) => {
      const r = checkEnvAdmission({ freeMB: 999999, rawMin: v });
      expect(r.ok, 'rawMin=' + JSON.stringify(v) + ' 必须判红').toBe(false);
      expect(r.admitted).toBe(false);
      expect(r.reason).toContain(ENV_ADMISSION.minVar);
    });
  });

  it('未设 / 空串 ⇒ 用默认门槛、`override:false`（默认档一个字节都不多打）', () => {
    [undefined, null, ''].forEach((v) => {
      const r = checkEnvAdmission({ freeMB: 999999, rawMin: v });
      expect(r).toMatchObject({ ok: true, admitted: true, minMB: ENV_ADMISSION.minFreeMemMB, override: false });
    });
  });
});

/* ============================================================
 * ④ `verify.js` 侧的三件纯函数：报文必须教会下一个人怎么办（`R1d` + "报错即教程"）
 * ============================================================ */
describe('`verify.js`：报文与结果行', () => {
  const refused = checkEnvAdmission({ freeMB: ENV_ADMISSION.minFreeMemMB - 1 });

  it('★ 拒绝报文必须说清三件事：不是产品红 / 一条断言都没跑 / 怎么办', () => {
    const text = verify.envRefusalLines(refused, ENV_ADMISSION.refusedExitCode, ENV_ADMISSION.minVar).join('\n');
    expect(text).toContain('不是产品红');
    expect(text).toContain('没有执行');
    expect(text).toContain('一条断言都没跑');
    expect(text).toContain('怎么办');
    expect(text).toContain('exit ' + ENV_ADMISSION.refusedExitCode);   // 退出码写进报文，读者不必猜
    expect(text).toContain(ENV_ADMISSION.minVar);                      // 出路要给到具体开关名
    expect(text).toContain('envRefused');                              // 记录位也要指出来
  });

  it('放行报文必须带**门槛**（否则"门槛被改小过"这件事看不见）', () => {
    const ok = checkEnvAdmission({ freeMB: ENV_ADMISSION.minFreeMemMB * 2 });
    const line = verify.envAdmittedLine(ok, ENV_ADMISSION.minVar);
    expect(line).toContain(String(ok.freeMB));
    expect(line).toContain(String(ok.minMB));
    const over = checkEnvAdmission({ freeMB: 10, rawMin: '1' });
    expect(verify.envAdmittedLine(over, ENV_ADMISSION.minVar)).toContain('覆盖');
  });

  it('拒绝结果行的形状：耗时 0、退出码 = 拒绝码、带 `envRefused:true`', () => {
    const row = verify.envRefusedRow({ step: 14, gate: 'G5', label: '冒烟断言' }, ENV_ADMISSION.refusedExitCode, 'full');
    expect(row).toMatchObject({ step: 14, gate: 'G5', ms: 0, code: ENV_ADMISSION.refusedExitCode, envRefused: true });
    expect(row.budgetMs).toBe(0);      // 没跑就没有"超预算"可言
  });

  it('★ 拒绝必须**落盘可区分**：历史记录里带 `envRefused`，通过的那条不带', () => {
    const env = { node: 'v0', host: 'h', freeMemMB: 1 };
    const bad = verify.buildVerifyHistory(
      { finishedAt: 'T', ok: false, failedGate: 'G5', totalMs: 1 },
      [verify.envRefusedRow({ step: 14, gate: 'G5', label: '冒烟断言' }, ENV_ADMISSION.refusedExitCode, 'full')],
      env);
    expect(bad.envRefused).toBe('G5');
    expect(bad.ok).toBe(false);
    const good = verify.buildVerifyHistory(
      { finishedAt: 'T', ok: true, failedGate: null, totalMs: 1 },
      [{ gate: 'G5', ms: 1000, code: 0, budgetMs: 0, tier: 'full' }],
      env);
    /* 通过的那条**落盘后不带这个字段**：`buildVerifyHistory` 用 `undefined` 表示"没有"，
     * 而 `JSON.stringify` 会把它整条省略 ⇒ `.review/verify-history.jsonl` 里干净 ✓
     * （断言落在**序列化后**的文本上，因为落盘的才是被读的东西）。 */
    expect(JSON.stringify(good)).not.toContain('envRefused');
    expect(good.envRefused).toBeUndefined();  });
});

/* ============================================================
 * ⑤ 接线（"判定对了但没接上" = 没做）
 * ============================================================ */
describe('接线：`verify.js` 的 G5 前置', () => {
  it('★ G5 步骤里调用了唯一实现 `checkEnvAdmission`，且**在 spawnSync 之前**', () => {
    const iG5 = verifySrc.indexOf("if (s.gate === 'G5') {\n      const smokeLib = require('./smoke-assertions.js');");
    expect(iG5, 'G5 的环境准入前置不见了（接线被摘掉）').toBeGreaterThan(0);
    const iCall = verifySrc.indexOf('smokeLib.checkEnvAdmission(', iG5);
    const iSpawn = verifySrc.indexOf('const r = spawnSync(s.cmd, opts);', iG5);
    expect(iCall).toBeGreaterThan(iG5);
    expect(iSpawn).toBeGreaterThan(iCall);            // 先判环境，再起进程 ✓
  });

  it('★ 拒绝时**不 spawn**（`break` 在 spawn 之前），并且退出码用 `failed.envRefused` 分流', () => {
    const iRefuse = verifySrc.indexOf('failed = { step: s, code: refusedCode, envRefused: true };');
    expect(iRefuse).toBeGreaterThan(0);
    expect(verifySrc.indexOf('process.exitCode = failed.envRefused ? failed.code : 1;')).toBeGreaterThan(0);
  });

  it('只挂 G5（唯一真起 Electron 的步骤）—— 判据不该拦别的步骤', () => {
    // 全文件里对 checkEnvAdmission 的调用点只有一处
    const calls = verifySrc.split('smokeLib.checkEnvAdmission(').length - 1;
    expect(calls).toBe(1);
  });

  it('`docs/RULES.md` 里那条旁注指向同一个实现（同一份事实不写两处）', () => {
    expect(rulesSrc).toContain('环境准入');
    expect(rulesSrc).toContain('checkEnvAdmission');   // 规则只说"去哪取"，实现只有一处
    expect(rulesSrc).toContain('ENV_ADMISSION');       // 门槛值不在规则里抄一份
  });
});
