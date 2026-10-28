/* ============================================================
 * tests/argv-unknown.test.js — 命令行参数的**单一来源**与"未知参数必红"（2026-10-71 批）
 * ------------------------------------------------------------
 * 本文件要防的是一起**已经发生**的事故：
 *   某批验收时把 `--version` 误写进命令，当时的参数解析是"**没认出来就当没有**" ⇒
 *   进程按普通模式起了一次应用 ⇒ 用户桌面上出现一个**可见窗口约 4 分钟**（16:17–16:21）。
 *   ⇒ 修法在参数解析这一层：任何不被识别的 `--xxx` / 多余位置参数 ⇒ exit 2 + 点名 + 用法摘要。
 *
 * 【判据都在参数层，**绝不开窗口**】（本工程的最高优先约束）
 *   `main.js` 的参数层在**主 require 块之前**（只先 require 一个 `path`）⇒
 *     · 未知参数 ⇒ 纯 node 下就 exit 2（连 electron 都还没 require）；
 *     · 合法参数 + `AI_MINDMAP_ARGV_AUDIT_ONLY=1` ⇒ 打完解析结果就 exit 0。
 *   于是"这两侧"都能用**真文件、真进程**取证，而不需要真起一次应用 —— 也就不会开任何窗口。
 *   ⚠️ 本文件**不能**证明的：真实 Electron 里无参数启动后界面长什么样（那不是本文件的职责，
 *      也不该由单测去开窗口验）。真实 Electron 那一侧的读数在
 *      `.review/20261071-未知参数/argv-probe/electron-real-out.json`（带"审计出口"安全皮带）。
 *
 * 【"合法参数集合"怎么钉住 —— 两个方向，缺一都等于没修】
 *   ① 登记表 → 接受：`ARGV_SCHEMA` 的每一条都真跑（下面"该绿"那几例），必须不被判未知；
 *   ② 名字集合 → 快照：本文件里**逐条列出**应当存在的参数名，与 `main.js` 的登记表现算集合**逐字相等**。
 *      ⇒ 有人从登记表里**删掉一项**（比如 `--export-window`）⇒ ② 当场红（这条是本批明令的前置要求：
 *        "以后有人新增/删除参数忘了同步，那条钉住集合的单测会红"）。
 *   ③ `main.js` 里除参数层外**不许再直接读 `process.argv`** ⇒ 有人绕开登记表又解析一遍（新增参数
 *      忘了登记）⇒ ③ 红。这条是"忘了登记"的唯一机械判据，没有它这段就只是一句注释。
 *
 * 【注入验证（判别力）】三条判据都做过**反向注入**（读数与步骤见
 *   `.review/20261071-未知参数/README.md` 的「判别力注入」一节）：从登记表删一项 ⇒ ①②红；
 *   闸门钝化 / 登记表被架空 ⇒ ④⑤⑥红；只改一句文案（无害对照）⇒ 仍全绿。
 *
 * 【为什么 spawn 数被压到 12 次】一条判据 = 起一个真进程。本机实测**纯 node 启动本身就要
 *   ~640 ms**（`.review/20261071-未知参数/spawn-cost.json`：`node -e 0` median 643 ms、
 *   跑 `main.js` 参数层 median 541 ms ⇒ 成本几乎全在起进程）。所以这里不是"顺手多写几例"的地方：
 *   每次 spawn 都有明确判据，"一遍过全部合法参数"的合并例只用来取 plan，逐条的那 6 例各自独立。
 *   ⚠️ 上一版 20 次 spawn 在**全量套件**负载下**超 30 s 超时**（不是逻辑失败，是本工程反复踩过的
 *   环境/负载脆弱性）。数降下来 + 小并发（4 路）之后余量足够。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MAIN_PATH = path.join(ROOT, 'main.js');
const MAIN_SRC = readFileSync(MAIN_PATH, 'utf8');

/* ---------------- 应存在的合法参数：**逐条列名**（这是"钉住集合"的那一份快照） ----------------
 * 为什么要抄一份在这里（这不是"第二份实现"，是**判据本身**）：
 *   集合的正确性只有"与预期逐条比对"才判得出来；不写预期就没有"删一项会红"这回事。
 * 为什么这四条腿要分开列：它们的**语义不同**（无值开关 / 开关+位置参数 / `--名字=值` / 放行的上游开关），
 *   混成一个数组就看不出"`--export-image` 还欠着 2 个位置参数"这类漂移。
 * ⚠️ 新增参数时：`main.js` 的 `ARGV_SCHEMA` 加一条 + **这里**加一条，两处一起改。 */
const EXPECTED_FLAGS = ['--smoke', '--headless-control'];
const EXPECTED_VALUE_FLAGS = ['--export-image', '--export-window'];
const EXPECTED_INLINE = ['--smoke-only'];
const EXPECTED_PASSTHROUGH = [
  '--disable-gpu', '--in-process-gpu', '--no-sandbox',
  '--user-data-dir', '--inspect', '--inspect-brk', '--remote-debugging-port'
];

/** 起一个**纯 node** 的子进程跑真实的 main.js 参数层（不会碰 app、不会开窗口）。
 *  @param {string[]} args 参数（不带 app 路径 —— 纯 node 跑法下 argv[1] 是 main.js 自己）
 *  @param {{auditOnly?:boolean}} [opts] auditOnly=true 时置审计出口（跑完闸门就 exit 0）
 *  @returns {Promise<{status:number, text:string, plan:object|null, schema:object|null, reject:object|null}>} */
function runMain(args, opts) {
  const o = opts || {};
  const env = Object.assign({}, process.env);
  if (o.auditOnly) env.AI_MINDMAP_ARGV_AUDIT_ONLY = '1';
  else delete env.AI_MINDMAP_ARGV_AUDIT_ONLY;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN_PATH].concat(args), {
      cwd: ROOT, env: env, stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* 已经退了 */ } }, 50000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const pick = (prefix) => {
        const line = out.split(/\r?\n/).find((l) => l.indexOf(prefix) === 0);
        if (!line) return null;
        try { return JSON.parse(line.slice(prefix.length)); } catch (e) { return null; }
      };
      const audited = pick('ARGV-AUDIT ');
      resolve({
        status: code, text: out + err,
        plan: audited ? audited.plan : null,
        schema: audited ? audited.schema : null,
        reject: pick('ARGV-AUDIT-REJECT ')
      });
    });
  });
}

/** 小并发（limit 路）跑一组 async 任务，**保持返回顺序**。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(worker));
  return out;
}

const names = (list) => list.map((x) => x.name);
/** 一次"真实档"运行：判据只有"**不因未知参数退出**"。
 *  纯 node 下它会在第一次碰 `app.*` 处崩（`exit 1`）—— 那不是产品行为，恰恰证明闸门放行了。 */
async function assertNotRejected(args) {
  const r = await runMain(args);
  expect(r.status, '被判成未知参数 = 把合法参数判死（最坏的假红）：' + args.join(' ') + '\n' + r.text).not.toBe(2);
  expect(r.text, '报文出现了「未知参数」：' + args.join(' ')).not.toContain('未知参数');
  return r;
}

describe('命令行参数：单一来源 + 未知参数必红（参数层判据，不起应用）', () => {
  it('① 登记表 = 单一来源：四条腿的名字集合与快照**逐条相等**（删一项就红）', async () => {
    const r = await runMain([], { auditOnly: true });
    expect(r.status, '无参数 + 审计出口应当 exit 0\n' + r.text).toBe(0);
    expect(r.schema, '没读到 ARGV-AUDIT（解析结果与登记表）').toBeTruthy();
    const s = r.schema;
    expect(names(s.flags)).toEqual(EXPECTED_FLAGS);
    expect(names(s.valueFlags)).toEqual(EXPECTED_VALUE_FLAGS);
    expect(names(s.inlineFlags)).toEqual(EXPECTED_INLINE);
    expect(names(s.passthrough)).toEqual(EXPECTED_PASSTHROUGH);
    /* 位置参数槽位也要钉：`--export-image` 少写一个 `<out>` 就等于悄悄丢了导出目标 */
    const vf = Object.fromEntries(s.valueFlags.map((f) => [f.name, f.params.length]));
    expect(vf['--export-image']).toBe(2);
    expect(vf['--export-window']).toBe(1);
    /* 另一侧：无参数必须解析成"什么都没有"（② 的审计半边就这一条） */
    expect(r.plan).toMatchObject({
      smoke: false, headlessControl: false, exportImage: null, exportWindow: null, smokeOnly: null
    });
    /* 反向钉：事故里那个参数**在任何一条腿里都不许出现**（否则闸门等于被它绕过了） */
    const all = [].concat(names(s.flags), names(s.valueFlags), names(s.inlineFlags), names(s.passthrough));
    expect(all).not.toContain('--version');
  });

  it('② 无参数启动：**不因"未知参数"退出**（行为与改动前一致：放行去起应用）', async () => {
    await assertNotRejected([]);
  });

  it('③ 现存合法参数逐个试：真实档**不因未知参数退出**（6 例各自独立进程）', async () => {
    /* 覆盖登记表四条腿里的每一条：两条无值开关 / 两条带位置参数的 / 一条 `=` 形态 /
     * 三个 passthrough（含 `--user-data-dir=` 这种带值的）。 */
    const CASES = [
      ['--smoke'],
      ['--headless-control'],
      ['--smoke-only=14'],
      ['--export-image', 'comnet', 'out.png'],
      ['--export-window', 'win.png'],
      ['--smoke', '--disable-gpu', '--in-process-gpu', '--no-sandbox', '--user-data-dir=C:/tmp/mm-x']
    ];
    await mapLimit(CASES, 4, (args) => assertNotRejected(args));
  });

  it('④ 一遍过所有参数：审计档 plan 逐字段对（含 passthrough 的收集与位置参数落位）', async () => {
    const args = ['--smoke', '--headless-control', '--smoke-only=14,15',
      '--export-image', 'comnet', 'out.png', '--export-window', 'win.png',
      '--disable-gpu', '--in-process-gpu', '--user-data-dir=C:/tmp/mm-y'];
    const r = await runMain(args, { auditOnly: true });
    expect(r.status, '这一整行全是登记表里的参数，不该被判未知：' + args.join(' ') + '\n' + r.text).toBe(0);
    expect(r.plan).toEqual({
      smoke: true,
      headlessControl: true,
      smokeOnly: '14,15',
      exportImage: { project: 'comnet', out: 'out.png' },
      exportWindow: { out: 'win.png' },
      passthrough: ['--disable-gpu', '--in-process-gpu', '--user-data-dir=C:/tmp/mm-y']
    });
  });

  it('⑤ `--version`（本批事故里的那个参数）⇒ exit 2，且报文**点名**它', async () => {
    const [real, audit] = await mapLimit([0, 1], 2, (k) => runMain(['--version'], { auditOnly: k === 1 }));
    expect(real.status, '--version 必须 exit 2（它是本批要防的那起事故的触发参数）\n' + real.text).toBe(2);
    expect(real.text).toContain('--version');                 // 点名
    expect(real.text).toContain('未知参数');
    expect(real.text).toContain('用法：electron . [参数]');      // 用法摘要
    /* 机器可读的那一侧：拒绝报文里点名的是**同一个 token** */
    expect(audit.status).toBe(2);
    expect(audit.reject && audit.reject.unknown).toContain('--version');
    /* 审计出口**只许多一行**：把那一行机器可读的去掉之后，拒绝报文必须与生产档**逐字相同**
     * （否则那个"只给单测用"的口子迟早变成"两套文案"，而两套文案 = 判据与产品各说一套） */
    const strip = (t) => t.split(/\r?\n/).filter((l) => l.indexOf('ARGV-AUDIT-REJECT ') !== 0).join('\n').trim();
    expect(strip(audit.text), '审计档的拒绝报文与生产档不一致').toBe(real.text.trim());
    /* 闸门在碰 app / 碰 require 之前：不许出现任何"应用已起来"的痕迹（本批的最高优先约束） */
    ['[main] window created', '[main] registerIpc ok', 'did-finish-load'].forEach((m) => {
      expect(real.text).not.toContain(m);
    });
  });

  it('⑥ `--foo-bar`（不存在的参数）⇒ exit 2，且报文点名它', async () => {
    const r = await runMain(['--foo-bar']);
    expect(r.status, '不认识的开关必须响亮点名退出\n' + r.text).toBe(2);
    expect(r.text).toContain('--foo-bar');
    expect(r.text).toContain('未知参数');
  });

  it('⑦ 多余的位置参数 / 残缺的开关值 / 裸写的 `=` 形态 ⇒ exit 2，且逐条说清**为什么**', async () => {
    /* 一次点名三种错（同一个进程里三条都要出现在报文里）—— 这一例代替三次 spawn，判据不减。 */
    const r = await runMain(['comnet', '--smoke-only', '--export-image']);
    expect(r.status, '这三种错都必须 exit 2\n' + r.text).toBe(2);
    expect(r.text, '多余位置参数没被点名').toContain('comnet');
    expect(r.text, '没说清它是位置参数').toContain('位置参数');
    expect(r.text, '裸写的 --smoke-only 没被点名').toContain('--smoke-only');
    expect(r.text, '残缺的 --export-image 没被点名').toContain('--export-image');
    expect(r.text, '没说清是残缺值').toContain('参数不完整');
  });

  it('⑧ main.js 里除参数层外**不许**再直接读 process.argv（新增参数忘了登记的机械判据）', () => {
    /* 只看**代码行**：注释里提 `process.argv` 是文档，不是第二份解析（本工程的同款口径见
     * `tests/export-png-single-path.test.js` 的 `codeLines()`）。 */
    const code = MAIN_SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const start = code.indexOf('const ARGV_SCHEMA');
    const end = code.indexOf('const isSmoke = ARGV.');
    expect(start, '找不到登记表 ARGV_SCHEMA（参数层被删了？）').toBeGreaterThan(-1);
    expect(end, '找不到闸门的出口 `const isSmoke = ARGV.`').toBeGreaterThan(start);
    const hits = [];
    const re = /process\.argv/g;
    let m;
    while ((m = re.exec(code)) !== null) hits.push(m.index);
    const outside = hits.filter((i) => i < start || i >= end);
    expect(outside.map((i) => code.slice(i, i + 20)), '参数层之外还有 process.argv 读取 —— 绕开了登记表').toEqual([]);
    /* 参数层里**只应有一处**：把 `process.argv` 交给 userArgvOf() 那一次。
     * 多一处就说明有人在参数层里又解析了一遍（两份解析 = 迟早两套语义）。 */
    expect(hits.length, '参数层里 `process.argv` 应当恰出现一次（交给 userArgvOf）').toBe(1);
    /* 参数层还要在**主 require 块之前**：否则"未知参数"要等 electron/侧栏/src 全加载完才判 */
    const electronReq = code.indexOf("const { app, BrowserWindow");
    expect(electronReq, '找不到主 require 那一行').toBeGreaterThan(-1);
    expect(start, '参数层没有跑到主 require 之前').toBeLessThan(electronReq);
  });
});
