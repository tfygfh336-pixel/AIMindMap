/* ============================================================
 * scripts/smoke/temp-run-root.js —— 冒烟域的**唯一临时根**（纯函数 + 一小段 I/O）
 * ------------------------------------------------------------
 * 为什么需要：冒烟域里要给"选目录 / 导入源 / vault 库"造**真实目录**，历史写法是
 * `path.join(os.tmpdir(), 'zz-bind-ui-src')` 这类**固定名**。固定名有两个已经真实发生过的后果：
 *   ① **并发跑同一域时两次运行互删**（实测：另一个会话把域 42 的源目录删掉 ⇒ 本域判据读不到文件，
 *      报成 ENOENT / 判据红 —— 看起来像产品缺陷，实际是环境 ✗）。域 43/44 是同一形态。
 *   ② 收尾**写漏一处就永久残留**（实测：域 44 的 `cleanupSandbox()` 从来没被调用过 ⇒ 每次全链在
 *      `%TEMP%` 留下 `zz-w12-vault` / `zz-w12-vaultlib` / `zz-w12-plain` 三个目录）。
 *
 * 本模块把"唯一 + 收尾"变成**一个入口**（照 skill E2/E5：临时物名字带运行标识；清理名单只许一处）：
 *   唯一：根名 = `<prefix>-<pid>-<base36 时刻>-<序号>` ⇒ 两次并发运行各有各的根，互不干涉 ✓；
 *   收尾：`cleanup()` 只删**自己那一个根**（绝不按通配扫"本目录下所有 tmp-*" ✗）；崩在半路时由
 *         下一次运行开头的 `sweepStale()` 兜底 —— 它只认自己的前缀、且**只删 30 分钟以上的**
 *         （域自己跑一轮 < 2 分钟 ⇒ 误删在跑的那一轮的风险被 15 倍余量压到实际为零）；
 *   ⭐ `sweepStale()` 的返回值**必须能区分三态**（`0 个陈旧项` / `N 个已清扫` / `清扫失败`）——
 *     2026-10-18 实测：它曾经在 `readdirSync` 抛错时只给一个 `swept:0`，把"清扫失败"与"没有陈旧项"
 *     压成同一个 0 ⇒ 判据对"清扫这条路整个坏掉"是瞎的（详见下面 `sweepStale` 的注释）；
 *   ⭐ 域里**必须**走 `sweepStaleOrThrow()` 而不是裸 `sweepStale()`（见下面那一节）：
 *     三态只有**被看**才有意义 —— 域 42/43/44 曾经三处都把返回值扔掉，`ok:false` 被静默吞掉；
 *   基名：`under(name)` 里的 `name` **必须是原来那个基名**（`zz-imp-lib` 之类）—— 域 43/44 的
 *         新项目名是主进程**从目录名推**出来的（`sanitizeProjectName(basename(dir))`），
 *         把唯一段写在基名上会连带改掉项目名 ⇒ 唯一段只许写在**父目录**上 ✓。
 *
 * 用法（域里三行）：
 *     const tempRunRoot = require('../temp-run-root.js');
 *     const RUN = tempRunRoot.planRunRoot('zz-bind-ui');            // 只算路径，**不动盘**
 *     const SRC_DIR = RUN.under('zz-bind-ui-src');                  // 名字与改动前一致
 *     ... RUN.reset('zz-bind-ui-src')  建/清空 ... 写夹具 ...
 *     ... RUN.cleanup()                收尾（放在整段 try/finally 里）...
 * ⚠️ `planRunRoot` **不在模块加载期建目录**：域文件在冒烟启动时会被全部 `require`（含被
 *   `SMOKE_ONLY` 过滤掉的那些）⇒ 加载期建目录就会给"没跑的域"留下残留 ✗。
 * ============================================================ */
'use strict';

const nodeFs = require('fs');
const nodeOs = require('os');
const nodePath = require('path');

/** 兜底清扫的年龄线（毫秒）：域自己一轮 < 2 分钟 ⇒ 15 倍余量 */
const STALE_MS = 30 * 60 * 1000;

let seq = 0;

/** 运行标识：pid + 时刻 + 进程内序号（同一进程里建多个根也各不相同） */
function runTag(nowMs) {
  seq += 1;
  return process.pid + '-' + Number(nowMs === undefined ? Date.now() : nowMs).toString(36) + '-' + seq;
}

/**
 * 造一个"本次运行独有的临时根"的**句柄**（不建目录）。
 * @param {string} prefix 根名前缀（如 `zz-bind-ui`）—— 也是 `sweepStale` 的认领前缀
 * @param {{fs?:object, os?:object, path?:object, tag?:string}} [io]
 */
function planRunRoot(prefix, io) {
  const fs = (io && io.fs) || nodeFs;
  const os = (io && io.os) || nodeOs;
  const path = (io && io.path) || nodePath;
  if (!prefix) throw new Error('planRunRoot 需要前缀（否则无法与别人的临时目录区分）');
  const root = path.join(os.tmpdir(), prefix + '-' + ((io && io.tag) || runTag()));
  const dirOf = (name) => path.join(root, name);
  return {
    prefix,
    root,
    /** 根底下的一个子路径（**只算路径，不动盘**）：`name` = 改动前那个基名 ✓ */
    under: dirOf,
    exists() { return fs.existsSync(root); },
    /** 建 / 清空一个子目录（第一次调用才真的把根建出来） */
    reset(name) {
      const dir = dirOf(name);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 不存在即正常 */ }
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    /** 只建不删（给"要在空目录上再手工铺结构"的域用） */
    ensure(name) {
      const dir = dirOf(name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    /** 收尾：**只删自己那一个根**（别人的根、别人的前缀，一个都不碰 ✓） */
    cleanup() {
      try { fs.rmSync(root, { recursive: true, force: true }); return true; }
      catch (e) { return false; }
    }
  };
}

/** 逐条失败的原话（诊断用；**不参与**判定） */
function codeOf(e) { return String((e && (e.code || e.message)) || e || 'unknown'); }

/**
 * 兜底清扫：本前缀下**年龄超过 `maxAgeMs`** 的残留根（上一次运行崩在半路留下的）。
 * 为什么带年龄线而不是"清掉所有同前缀的"：正在跑的那一轮也在同一前缀下 ⇒ 不加年龄线就会
 * 把别人的活目录删掉（那正是域 42 那条假红的形状 ✗）。
 *
 * ⭐ **答案空间必须能区分三态**（`B4b` / `B4c`：判定档数不许少于要区分的状态数）：
 *   ① `0 个陈旧项`   ⇒ `{ok:true,  swept:0, kept:N, failed:0, error:''}`
 *   ② `N 个已清扫`   ⇒ `{ok:true,  swept:N, kept:M, failed:0, error:''}`
 *   ③ **`清扫失败`** ⇒ `{ok:false, error:'…'}`（`readdirSync` 读不出 `%TEMP%`）
 *                      或 `{ok:false, failed:k, errors:[{name,op,code}]}`（逐条目 `stat` / `rm` 失败）
 *
 * 为什么必须这样（2026-10-18 实测，`.review/20261018-判据间歇红/`）：
 *   · 改动前 `readdirSync` 抛错只会 `return {swept:0, error}`，而调用方的断言**只看 `out.swept`**
 *     ⇒ "清扫整条路坏了"与"没有陈旧项"被压成**同一个 0** ⇒ 判据对"清扫这条路整个坏掉"是**瞎的**，
 *     红的时候也只报一句 `expected 0 to be 1`，分不清是环境问题还是实现问题；
 *   · 另一处同类压平：`rmSync` 失败**曾计入 `kept`** ⇒ "新鲜所以留着"与"删不掉所以还在"同一个数；
 *   · `statSync` 失败曾 `continue` 静默跳过 ⇒ 那个条目既不进 `swept` 也不进 `kept`，**凭空消失**。
 *
 * **时间基准是可注入的**（`nowMs`）：判据可以把它钉住，于是"30 分钟"这条常量不再绑定
 * **滚动运行时数据**（`B1b` 的形态）。生产路径不传 ⇒ 仍是 `Date.now()`（语义不变）。
 * @returns {{ok:boolean, swept:number, kept:number, failed:number, names:string[],
 *            errors:Array<{name:string,op:string,code:string}>, error:string}}
 */
function sweepStale(prefix, opts) {
  const o = opts || {};
  const fs = o.fs || nodeFs;
  const os = o.os || nodeOs;
  const path = o.path || nodePath;
  const maxAgeMs = o.maxAgeMs === undefined ? STALE_MS : o.maxAgeMs;
  const now = o.nowMs === undefined ? Date.now() : o.nowMs;
  const out = { ok: true, swept: 0, kept: 0, failed: 0, names: [], errors: [], error: '' };
  let entries = [];
  try { entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true }); }
  catch (e) { out.ok = false; out.error = String((e && e.message) || e); return out; }
  for (const e of entries) {
    if (e.name.indexOf(prefix + '-') !== 0) continue;
    const p = path.join(os.tmpdir(), e.name);
    let st = null;
    try { st = fs.statSync(p); }
    catch (err) {
      /* 读不到年龄 ⇒ **不许**当成"新鲜所以留着"，也不许静默跳过 ⇒ 单列一档 */
      out.ok = false; out.failed += 1;
      out.errors.push({ name: e.name, op: 'stat', code: codeOf(err) });
      continue;
    }
    if (now - st.mtimeMs < maxAgeMs) { out.kept += 1; continue; }
    try { fs.rmSync(p, { recursive: true, force: true }); out.swept += 1; out.names.push(e.name); }
    catch (err) {
      /* 删不掉 ≠ 新鲜 ⇒ **不许并进 kept** */
      out.ok = false; out.failed += 1;
      out.errors.push({ name: e.name, op: 'rm', code: codeOf(err) });
    }
  }
  return out;
}

/* ============================================================
 * 域里的**唯一调用形态**：`sweepStaleOrThrow()` —— 清扫失败 ⇒ 该断言当场判红
 * ------------------------------------------------------------
 * 为什么要再包一层（2026-10-18 补的、还上一批登记的债）：
 *   `sweepStale()` 已经被改成三态，但域 42 / 43 / 44 三处调用**都把返回值扔掉了**
 *   （`tempRunRoot.sweepStale(RUN.prefix);` 这种裸表达式语句）⇒ `ok:false`（清扫这条路整个坏掉）
 *   与 `swept:0`（没有陈旧项）在**调用面上**又合并成"什么也没发生"，一句失败都不会出现 ——
 *   那正是本工程反复治的病（"一条会静默失败的判据，比缺失的更坏"，`architecture-for-ai` F1）。
 *
 * 为什么是"抛"而不是"在成功行里点名"：清扫失败意味着**这一次运行起手的前提没验成**
 *   （残留有没有、清没清干净都不知道），此后几条断言都在一个来源不明的沙箱上跑 ⇒ 结论不可信。
 *   `main.js` 的冒烟循环把断言抛错记成 `[FAIL] … :: THREW: …`（报文含 对象 / 期望 / 实际），
 *   于是失败**比成功更响**，而不是被降级成日志里的一行（那正是上一批记下的债）。
 *
 * 为什么三个域不许各写一套判断：三份判断必然漂成三种口径（`A1` / `A3`）⇒ 判断只写在这里，
 *   域里只留一句"调用"（三个域的文件里都注明了这条）。
 *
 * 判别力证明是**永久可复跑**的：`MM_SMOKE_INJECT=sweep-fail`（配 `SMOKE_ONLY=42|43|44`）
 *   ⇒ 让 `readdirSync` 恒抛 ⇒ `sweepStale` 恒 `ok:false` ⇒ 那三个域**必须**当场红。
 *   默认空 ⇒ 注入分支一次都不进（与改动前逐字节等价），且**不存在"改文件忘了还原"**这一类事故。
 * ============================================================ */

/** 判别力注入的键名（本仓既有约定 `MM_SMOKE_INJECT=<key>`；只认这一个值，别的注入值一概忽略） */
const SWEEP_FAIL_KEY = 'sweep-fail';

/**
 * `MM_SMOKE_INJECT=sweep-fail` ⇒ 返回一只"`readdirSync` 恒抛"的 fs 桩（其余方法走真的），
 * `sweepStale` 的第一步就会走进 `ok:false` 分支 —— 注入的是**生产路径上的同一处**失败，不是另写一条。
 * @param {{fs?:object}} [opts]
 */
function injectSweepFail(opts) {
  const key = String(process.env.MM_SMOKE_INJECT || '').trim();
  if (key !== SWEEP_FAIL_KEY) return opts;
  const base = (opts && opts.fs) || nodeFs;
  const poisoned = new Proxy(base, {
    get(t, k) {
      if (k === 'readdirSync') {
        return () => {
          const e = new Error('EINJECTED: MM_SMOKE_INJECT=' + SWEEP_FAIL_KEY);
          e.code = 'EINJECTED';
          throw e;
        };
      }
      return t[k];
    }
  });
  return Object.assign({}, opts || {}, { fs: poisoned });
}

/**
 * 域里的唯一调用形态：**清扫失败 ⇒ 抛**（该断言判红）；成功 ⇒ 返回三态读数并打一行成功读数。
 * 报文按 `B1` 的三段写全：**对象**（前缀 + 扫描面）/ **期望** `ok:true` / **实际** `ok:false` 的原因。
 * @returns {{ok:boolean, swept:number, kept:number, failed:number, names:string[],
 *            errors:Array<{name:string,op:string,code:string}>, error:string}}
 */
function sweepStaleOrThrow(prefix, opts) {
  const out = sweepStale(prefix, injectSweepFail(opts));
  const where = ((opts && opts.os) || nodeOs).tmpdir();
  if (out.ok !== true) {
    const detail = out.error
      ? 'error=' + out.error
      : '逐条失败 ' + out.failed + ' 项：' + JSON.stringify(out.errors || []);
    const e = new Error('兜底清扫失败（前缀 ' + prefix + '，扫描面 ' + where + '）：' + detail
      + ' ⇒ **期望** ok:true，**实际** ok:false'
      + ' ⇒ 本次「没有陈旧残留」无法判定（**不许**读成 0 项，也不许当成"没东西要清"）');
    e.code = 'ESWEEP_FAILED';
    e.sweep = out;
    throw e;
  }
  /* 成功也留一行读数：否则"清扫这件事到底跑了没"在日志里没有痕迹 ——
   * 绿的运行里也要能读出"已清几个 / 保留几个"，否则下一次怀疑它空转时又只能靠翻代码。 */
  console.log('[temp-run-root] 兜底清扫 ' + prefix + '：已清 ' + out.swept + ' 项 / 新鲜保留 ' + out.kept
    + ' 项（前缀不匹配的不计；扫描面 ' + where + '）');
  return out;
}

module.exports = { planRunRoot, sweepStale, sweepStaleOrThrow, runTag, STALE_MS };
