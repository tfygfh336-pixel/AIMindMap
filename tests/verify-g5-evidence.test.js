/* ============================================================
 * tests/verify-g5-evidence.test.js — G5 的证据留存（2026-10-27 收口批）
 * ------------------------------------------------------------
 * 为什么有这份用例：本批修的是"全链红在 G5 时**只有一句退出码**"这条体系欠账。
 * 证据留存这件事**天生容易做假** —— 落盘那行删掉，代码看起来仍然"有落盘"，
 * 而后果要等到下一次全量冒烟跑完（1000 s 量级）才暴露 ⇒ 必须钉成判定。
 *
 * 钉的是四件事（每条都对应一个"删掉它就退回原状"的注入点）：
 *   ① **路径**：日志在 `.review/verify-logs/` 下（`.review/` 已被 gitignore ⇒ G1/G8 不会红）；
 *   ② **摘证据要扫全文**：唯一的 `[FAIL]` 往往离结尾很远（实测 365 KB 的日志里那 1 条 FAIL
 *      在 2 万余行中的第 1966 行）⇒ 只打末尾会**漏掉唯一的那条失败**；
 *   ③ **报文里必须有路径**：没有它就等于没落盘（读者仍然只能重跑全链）；
 *   ④ **判定口径不许被这件事带跑**：仍然只看退出码，且捕获**不许用管道**
 *      （`scripts/verify.js` 文件头 ①：受限环境禁止管道 stdio ⇒ 用管道会让整条链假失败）。
 *
 * ⚠️ 与 `tests/verify-budget.test.js` 的分工：那份守"耗时预算"，这份守"G5 的证据"。
 *   两者都从 `scripts/verify.js` **现读**，不抄数字（抄一份就会漂）。
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
const VERIFY_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'verify.js'), 'utf8');

/** 造一段"冒烟式"日志：`lines` 行，`failAt`（1 基）那一行是 `[FAIL]`，其余是 `[PASS]` */
function fakeSmokeLog(lines, failAt) {
  const out = [];
  for (let i = 1; i <= lines; i++) {
    out.push(i === failAt ? '[FAIL] 某条断言 :: 期望 true 实得 false（读数 12/7）' : '[PASS] 断言 ' + i);
  }
  return out.join('\n');
}

describe('G5 证据留存：日志路径（①）', () => {
  it('落在 `.review/` 根下（**平铺**）、文件名带档位与时刻（便于与验证历史对齐）', () => {
    const rel = verify.g5LogRel('full', Date.parse('2026-10-27T09:05:07'));
    expect(rel.startsWith(verify.G5_LOG_PREFIX)).toBe(true);
    expect(rel).toBe('.review/g5-full-20261027-090507.log');
    // 三档都认得（subset 是人点名的收窄集，fast 是分层快档）
    expect(verify.g5LogRel('fast', 0)).toContain('/g5-fast-');
    expect(verify.g5LogRel('subset', 0)).toContain('/g5-subset-');
    // 未知档位不能造出奇怪的文件名 ⇒ 落回 full（"不知道"不许静默变成空档位）
    expect(verify.g5LogRel('whatever', 0)).toContain('/g5-full-');
    // 确定性：同一时刻两次调用同一个字符串（文件名里不许有随机/浮点尾巴）
    expect(verify.g5LogRel('full', 1234567890123)).toBe(verify.g5LogRel('full', 1234567890123));
    /* **为什么是平铺、不是建一个子目录**（本批第一版建了 `.review/verify-logs/`，被两道门禁当场抓住 ——
     * 两道都是真判据，所以改的是设计、不是判据）：
     *   ① **G8 第九条**要求 `.review/` 的每个直接子目录都有带状态词的 `README.md`，而 G8 是**第 2 步**、
     *      G5 是**第 16 步** ⇒ "整目录删掉 `.review/` 之后，再下一轮 G8 判红"这个鸡生蛋解不掉；
     *   ② **S2 写盘出口**会把"写那份 README"判成"可能在写受管资产"（目标判不了 + 本文件提得到受管资产名）。
     * ⇒ 平铺之后一条判据都不用动。这条断言把"别再往回改成子目录"钉住。 */
    expect(rel.split('/').length, '日志应平铺在 .review/ 根（`<根>/g5-….log`）').toBe(2);
    expect(verify.G5_LOG_ROOT).toBe('.review');
  });

  it('**这些日志确实被 gitignore**（`.review/` 是父级闸，且有一条显式规则 —— 甲-3）', () => {
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    // ① 父级闸：工作产物区整目录忽略
    expect(gi, '`.review/` 必须整目录忽略（本工程的落盘规矩：工作产物区不入库）').toMatch(/^\.review\/$/m);
    // ② 显式一条：让"G5 日志被忽略"这件事**可 grep、可判**
    //    （父级规则已经盖住它 —— 这条是给判据用的，不是唯一闸门；理由写成了 .gitignore 里的注释）
    const rule = verify.G5_LOG_ROOT + '/g5-*.log';
    const lines = gi.split(/\r?\n/);
    expect(lines.indexOf(rule) >= 0, '`.gitignore` 里应有一条 `' + rule + '`（新产物必须进 .gitignore，'
      + '否则 G1/G8 会红）').toBe(true);
  });
});

describe('G5 证据留存：摘证据必须扫全文（②）', () => {
  it('**唯一的 `[FAIL]` 离结尾很远时也必须被摘出来**（这正是本批的病因）', () => {
    // 实测形状：一份 365 KB 的全量日志里只有 1 条 FAIL，它在第 1966 行、后面还有两万行 PASS
    const text = fakeSmokeLog(20000, 1966);
    const ev = verify.g5Evidence(text);
    expect(ev.lines).toBe(20000);
    expect(ev.failCount, '全文必须只数到 1 条').toBe(1);
    expect(ev.fails.length, '那一条必须出现在打印清单里').toBe(1);
    expect(ev.fails[0]).toContain('[FAIL] 某条断言');
    // 对照：**只打末尾会漏掉它** —— 这条断言把"为什么不能只 tail"钉成机械判据
    expect(ev.tail.join('\n')).not.toContain('[FAIL]');
  });

  it('末尾行数 / FAIL 行数都有上限，超长行被截断且**明说被截断**（不静默丢字）', () => {
    const lines = [];
    for (let i = 1; i <= 200; i++) lines.push(i % 2 ? '[FAIL] 失败 ' + i : '[PASS] 通过 ' + i);
    lines.push('[FAIL] ' + 'x'.repeat(3000));
    const ev = verify.g5Evidence(lines.join('\n'), { tail: 5, fail: 3 });
    expect(ev.tail.length).toBe(5);
    expect(ev.fails.length).toBe(3);
    expect(ev.failCount, 'failCount 报的是**全文**条数（不因为只打印 3 条就少报）').toBe(101);
    const clipped = verify.g5Evidence('[FAIL] ' + 'y'.repeat(3000), { lineMax: 100 });
    expect(clipped.fails[0].length).toBeLessThan(200);
    expect(clipped.fails[0]).toContain('截断');
  });

  it('其它失败形状也认（`FAILED` / `THREW`）；空日志不抛且如实报 0', () => {
    const ev = verify.g5Evidence('ok\nFAILED to load\nboom THREW x\n');
    expect(ev.failCount).toBe(2);
    expect(verify.g5Evidence('').lines).toBe(0);
    expect(verify.g5Evidence('').failCount).toBe(0);
    expect(verify.g5Evidence(null).lines).toBe(0);   // 读不出文件时传进来的就是 null
  });
});

describe('G5 证据留存：报文必须带路径与复跑入口（③）', () => {
  const info = {
    rel: '.review/verify-logs/g5-full-20261027-090507.log', bytes: 365660, code: 1,
    evidence: verify.g5Evidence(fakeSmokeLog(30, 7))
  };

  it('打印块里有：日志路径、字节数、`[FAIL]` 行、末尾行、两条复跑命令', () => {
    const text = verify.g5EvidenceLines(info).join('\n');
    expect(text).toContain(info.rel);
    expect(text).toContain('357.1 KB');
    expect(text).toContain('[FAIL] 某条断言');
    expect(text).toContain('末尾');
    // 复跑入口（甲：报文要写清怎么复跑单个域）
    expect(text).toContain('SMOKE_ONLY');
    expect(text).toContain('npm run smoke');
    expect(text).toContain('--domains');
    // ⚠️ 反例提示：PowerShell 的 `--smoke-only=01,02` 会被逗号分词打散
    expect(text).toContain('--smoke-only');
  });

  it('**一条 `[FAIL]` 都没有时不许装成断言失败**（要说清红的来源可能是启动/守卫/泄漏闸门）', () => {
    const text = verify.g5EvidenceLines({
      rel: 'x.log', bytes: 10, code: 1, evidence: verify.g5Evidence('[main] 启动失败\nEXIT 1')
    }).join('\n');
    expect(text).toContain('一条');
    expect(text).toContain('不是断言失败');
  });

  it('失败报文那一行里必须有路径（删掉它就等于没落盘 —— 甲-2 的判定面）', () => {
    const note = verify.g5FailureNote(info);
    expect(note).toContain(info.rel);
    expect(note).toContain('357.1 KB');
    // 空值也不许拼出"undefined"这种看不懂的东西
    expect(verify.g5FailureNote({})).toContain('未知');
    expect(verify.g5FailureNote({}).indexOf('undefined')).toBe(-1);
  });
});

describe('G5 证据留存：接线（源码现读，不抄实现）', () => {
  it('用**文件描述符**重定向，**不是管道**（受限环境禁止管道 stdio —— 文件头 ①）', () => {
    // 这条是本批最容易做坏的地方：改用 'pipe' 收集输出，在禁止管道的环境里会让整条链假失败
    expect(VERIFY_SRC).toContain("opts.stdio = ['inherit', g5LogFd, g5LogFd];");
    // 精确判"有没有把 stdio 配成管道"（注释里出现 'pipe' 这个词本身不算违反）
    expect(VERIFY_SRC, 'scripts/verify.js 不许把子进程 stdio 配成管道（文件头 ①）')
      .not.toMatch(/stdio\s*:\s*('pipe'|\[[^\]]*'pipe')/);
    expect(VERIFY_SRC).toContain('fs.openSync(absLog');
    expect(VERIFY_SRC).toContain('fs.closeSync(g5LogFd)');
  });

  it('判定仍**只认退出码**：G5 的判定不读 stdout（读输出就会被输出格式带跑）', () => {
    expect(VERIFY_SRC).toContain('const code = r.status === null ? 1 : r.status;');
    // 精确判"G5 这一步的判定有没有读输出"：只取 `spawnSync(s.cmd, opts)` 到 `code` 那一段
    // （文件里别处有 `git ... .stdout`，那是另一件事，不许被这条判据误伤）
    const from = VERIFY_SRC.indexOf('const r = spawnSync(s.cmd, opts);');
    expect(from).toBeGreaterThan(0);
    const to = VERIFY_SRC.indexOf('const code = r.status', from);
    expect(to).toBeGreaterThan(from);
    expect(VERIFY_SRC.slice(from, to), '判定不许读子进程输出（R1c：只认 exit code）').not.toContain('.stdout');
    expect(VERIFY_SRC).toContain('if (code !== 0) { failed = { step: s, code }; break; }');
  });

  it('两处接线都在：G5 跑完按退出码分支打证据，失败报文再补一行路径', () => {
    // ① 跑完之后：失败 ⇒ g5EvidenceLines(...)；通过 ⇒ 只报一行"输出在哪"
    expect(VERIFY_SRC).toContain('g5EvidenceLines(g5EvidenceInfo).forEach');
    expect(VERIFY_SRC).toContain('G5 全绿；stdout + stderr 全文留在');
    // ② 失败报文：G5 失败时必须补 g5FailureNote（否则读者拿到路径的唯一机会只剩刷屏）
    expect(VERIFY_SRC).toContain("if (failed.step.gate === 'G5' && !refusedRow) {");
    expect(VERIFY_SRC).toContain('g5FailureNote(g5EvidenceInfo)');
    // ③ 只在 G5 这一步动 stdio（别的步骤仍是 inherit，不许被顺手改成落盘）
    expect(VERIFY_SRC).toContain("if (s.gate === 'G5') {\n      try {\n        pruneG5Logs");
  });

  it('环境准入拒绝**不**去要日志（那一步一条断言都没跑，路径会把人引到错方向）', () => {
    expect(VERIFY_SRC).toContain('!refusedRow');
  });
});

describe('G5 证据留存：只留最近 K 份（日志不会无限长）', () => {
  it('多余的按文件名序清掉、保留最近 K 份；目录不存在不抛', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g5logs-'));
    try {
      const names = [];
      for (let i = 1; i <= 6; i++) {
        const n = 'g5-full-2026102' + i + '-000000.log';
        fs.writeFileSync(path.join(dir, n), 'x', 'utf8');
        names.push(n);
      }
      fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x', 'utf8');   // 非本机制的产物不许被清
      const gone = verify.pruneG5Logs(2, dir);
      expect(gone.sort()).toEqual(names.slice(0, 4).sort());
      const left = fs.readdirSync(dir).sort();
      expect(left).toContain('unrelated.txt');
      expect(left.filter((n) => /^g5-.*\.log$/.test(n))).toEqual(names.slice(4));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // 目录不存在 ⇒ 返回空数组，不抛（首次运行就是这样）
    expect(verify.pruneG5Logs(2, path.join(os.tmpdir(), 'no-such-g5-dir-' + Date.now()))).toEqual([]);
  });
});

/* ============================================================================
 * 乙（G3 预算）的两条机械判据
 * ----------------------------------------------------------------------------
 * `tests/verify-budget.test.js` 守的是"预算 ≥ 1.25 × 窗口 median"（下界）。
 * 这里补的是**另一半**：预算不许越过它的**合法上界**（合计预算给的那条线），
 * 以及"这个数旁边必须写着为什么"（乙-2）—— 否则下次抬线只会剩一句"这次刚好过"。
 * ========================================================================= */
describe('G3 预算：合法上界与"为什么这个数"（乙）', () => {
  const g3 = verify.STEPS.find((s) => s.gate === 'G3');

  it('G3 的预算必须**低于**它的合法上界（= 合计预算 − 其余各步）', () => {
    expect(g3, 'STEPS 里应有 G3').toBeTruthy();
    const others = verify.STEPS.reduce((n, s) => n + (s.gate === 'G3' ? 0 : (s.budgetMs || 0)), 0);
    const upper = verify.TOTAL_BUDGET_MS - others;
    expect(upper, '合法上界应远大于 0（否则这条判据空转）').toBeGreaterThan(0);
    expect(g3.budgetMs, 'G3 预算 ' + g3.budgetMs + 'ms 越过了合法上界 ' + upper
      + 'ms（= 合计 ' + verify.TOTAL_BUDGET_MS + ' − 其余各步 ' + others + '）⇒ 合计会抢在单步前面报红')
      .toBeLessThan(upper);
    // 也不许贴在上界上（那等于把"合计不抢在单步前面发声"这条不变量吃掉）
    expect(g3.budgetMs * 1.25).toBeLessThan(upper);
  });

  it('**预算表那条数旁边必须有依据注释**（median 口径 + 合法上界，可 grep —— 乙-2）', () => {
    const at = VERIFY_SRC.indexOf("gate: 'G3'");
    expect(at).toBeGreaterThan(0);
    const budgetAt = VERIFY_SRC.indexOf('budgetMs:', at);
    expect(budgetAt).toBeGreaterThan(at);
    const block = VERIFY_SRC.slice(at, budgetAt);
    expect(block, 'G3 的预算旁要写清"为什么是这个数"').toMatch(/median/);
    expect(block, '必须引用守卫的口径（1.25 × median），否则读者不知道下界从哪来').toMatch(/1\.25/);
    expect(block, '必须给出合法上界（合计预算 − 其余各步）').toMatch(/合法上界/);
    // 反例：只剩"这次刚好过"这种理由 ⇒ 上面三条一条都对不上，判红
    expect(block, '必须带上实测读数（"0.3–3s 余量"那类贴线证据）').toMatch(/\d+(\.\d+)?s/);
  });
});
