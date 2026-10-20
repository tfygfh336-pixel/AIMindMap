/* ============================================================
 * src/editor-probe.js —— 「本机装了哪些编辑器、各自能不能跳行」的**运行时探测**（只有 I/O，判断在 editor-candidates）
 * ------------------------------------------------------------
 * ## 为什么探测面要单独一个模块
 *   判据（选谁、传什么参数）必须在**纯函数**里（可 node 直测、可注入假读数）；探测必须**可注入**，
 *   否则"把探测结果换成假的 ⇒ 断言必红"这条判别力证明根本做不出来 —— 而它正是本批要防的
 *   那件事：**目录写死**。本机实测已经证明写死会漏人（父代理按常见落点探 → "Trae CN 没装"，
 *   而注册表 + `D:\Program Files\Trae CN\bin\trae-cn.cmd` 都在）。
 *
 * ## 探测面的四个来源（**由强到弱**；每条都带 `found` 出处，界面/日志能看出"凭什么说它装了"）
 *   1. `path`            —— PATH 上有这个名字（`where <name>`）⇒ 最强（用户敲得到就能用）
 *   2. `registry-scheme` —— `HKCU/HKLM\Software\Classes\<scheme>\shell\open\command`（**协议处理器**）
 *                           注册表里那条命令行就是 exe 的绝对路径 ⇒ 从它能反推出整套布局
 *   3. `app-paths`       —— `…\CurrentVersion\App Paths\<exe>`（Windows 官方的"应用注册点"）
 *   4. `known-dir`       —— 常见安装落点（**最弱**：换台机器/换安装器就可能漏 —— 本机就是这么漏的）
 *   ⚠️ 四个来源**都要探**，且结果**并集**（不是"前一个命中就停"）：同一台机器上 Cursor 从 PATH 找到、
 *      Trae CN 从注册表找到 —— 只留一条路就会漏一个。
 *
 * ## "能不能跳行"怎么判
 *   跑一次该 CLI 的 `--help`，交给 `MMEditorCandidates.parseGotoSupport()` 解析 —— **拿产品自己的输出当读数**。
 *   两个实测形态（本机 2026-10-16，都 exit 0）：
 *     · `"<dir>\Cursor.exe" "<dir>\resources\app\out\cli.js" --help`（`ELECTRON_RUN_AS_NODE=1`）
 *     · 同上换成 `"<dir>\Trae CN.exe"` —— **这是 cli.cmd 包装脚本自己那条命令**（实测它的全文就是这两步）
 *   ⚠️ 为什么不用 `cursor.cmd --help`：实测包装脚本会把 stdout 吞掉（父代理那一轮就卡在这里）；
 *      直接 `exe + cli.js` 才拿得到读数 ⇒ 探针按**这一条**起（也正是 `commandArguments()` 用的形态）。
 *
 * ## 只读
 *   全程只有 `where` / `reg query` / `--help` 三类调用与 `existsSync`：
 *   **不写注册表、不改文件关联、不起编辑器界面、不装东西**。
 * ============================================================ */
'use strict';

/* ---------- UMD 头（形态照 `docs/ARCHITECTURE.md` §2.3；对照模块 `src/palette-rank.js`）----------
 * 修复前（2026-10-20 实测）：`fs` / `path` / `{ spawnSync } = require('child_process')` 三条在模块顶层
 * ⇒ 浏览器端加载抛 `ReferenceError: require is not defined`。
 * 本模块要探本机装了什么编辑器（读注册表、跑 `where`）⇒ 浏览器端本来就不该可用；
 * 合规做法是显式守卫：函数都在，调到就抛一句明确的话（见 nodeTrap / nodeGlobal）。
 * ⚠️ `child_process` 在**加载时**就被解构（`const { spawnSync } = ...`）⇒ 替身必须是
 * "取属性得一个调用即抛的函数"，不能是"取属性即抛"（后者会让模块加载直接崩）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('fs'), require('path'), require('child_process'),
      require('./editor-candidates.js'), process);
  } else {
    root.MMEditorProbe = factory(nodeTrap('fs'), nodeTrap('path'), nodeTrap('child_process'),
      root.MMEditorCandidates, nodeGlobal('process'));
  }
  function nodeTrap(name) {
    const no = (prop) => function () {
      throw new Error('src/editor-probe.js 的 ' + name + '.' + prop + ' 需要 Node 环境（浏览器端没有 ' + name
        + '；探编辑器要读盘 / 起子进程，请走 CLI / IPC）');
    };
    return new Proxy({}, { get: (_t, prop) => (typeof prop === 'symbol' ? undefined : no(String(prop))) });
  }
  function nodeGlobal(name) {
    return new Proxy({}, {
      get: (_t, prop) => {
        if (typeof prop === 'symbol') return undefined;
        throw new Error('src/editor-probe.js 需要 Node 环境（浏览器端没有 ' + name + '.' + String(prop) + '；请走 CLI / IPC）');
      }
    });
  }
})(typeof self !== 'undefined' ? self : this, function (fs, path, childProcess, C, process) {

const { spawnSync } = childProcess;

/** 关心关联危害的扩展名（第 3 件的输入面；`.js` 是本机实测会**执行**的那一个）。 */
const EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.md', '.markdown', '.json', '.txt', '.html'];

/** 常见安装落点（**最弱的一档**，见文件头；用 catalog 的 exe 名拼，不新增第二张名单）。 */
function knownDirs(env) {
  const roots = [
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs') : '',
    env.ProgramFiles || '',
    env['ProgramFiles(x86)'] || ''
  ].filter(Boolean);
  return roots;
}

/* ---------------- 真实 I/O（探针用；测试用假 IO 替换它） ---------------- */
function defaultIo() {
  return {
    env: process.env,
    exists(p) {
      try { return fs.existsSync(p); } catch (e) { return false; }
    },
    listDir(dir) {
      try { return fs.readdirSync(dir); } catch (e) { return []; }
    },
    /** `where <name>` —— 只读、不执行目标；返回首个命中路径或 ''。 */
    which(name) {
      const r = spawnSync('where', [name], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      if (r.status !== 0 || !r.stdout) return '';
      const first = String(r.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      return first || '';
    },
    /** `reg query <key> /ve` —— 只读；返回 { ok, value }（`value` = 该键默认值那一列）。 */
    readRegKey(key) {
      const r = spawnSync('reg', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (r.status !== 0) return { ok: false, value: '', code: r.status };
      const m = /REG_\w+\s+(.*)$/m.exec(r.stdout || '');
      return { ok: true, value: m ? m[1].trim() : '' };
    },
    /** 跑一次 CLI 的 `--help`（**唯一一处会起子进程的地方**；超时即失败，不当成功）。 */
    runHelp(file, args, env) {
      const r = spawnSync(file, args, {
        encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024,
        env: Object.assign({}, process.env, env || {}),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      if (r.error) return { ok: false, why: 'spawn 失败：' + (r.error.code || r.error.message) };
      if (r.status !== 0) return { ok: false, why: 'exit ' + r.status };
      return { ok: true, out: (r.stdout || '') + (r.stderr || '') };
    }
  };
}

/** 把一个"命中的路径"解析成"能跑的 CLI"（返回 `{file, args, head, how}` 或 `null`）。
 *
 *  ⚠️ 命中的路径**未必是 exe** —— 本机实测两种形态都出现过：
 *    · `where cursor` → `D:\Program Files\cursor\resources\app\bin\cursor`（**无扩展名的 shim**）
 *    · 真 exe        → `D:\Program Files\cursor\Cursor.exe`
 *    注册表 scheme 给的则一定是命令行里那个 exe（带引号）。
 *  ⇒ 做法：从命中路径**逐级向上**找"安装根"（判据 = 根下有 `resources\app\out\cli.js` **且**
 *    有该候选的 exe 名），找到就返回 `{file: <exe>, head: [cli.js]}`。
 *    这是 VS Code 家族（Cursor / Trae CN / VS Code / Windsurf）实测的布局，也是**唯一**能拿到
 *    stdout 的起法（`cursor.cmd` 包装脚本会吞输出 —— 父代理那一轮卡在这里）。
 *  找不到安装根时：命中路径自己若是 `.exe` ⇒ 直接当 CLI（`subl.exe` / `notepad++.exe` 那类）。
 *  只剩 `.cmd`/`.bat` ⇒ **返回 null**：`spawn` 起不了它，而"为了起它去拼命令行字符串"会引入
 *  注入面（本批硬纪律禁止）⇒ 如实退成 `open` 档，并记一条 reason。
 */
function resolveCli(io, def, hitPath) {
  const p0 = String(hitPath || '');
  if (!p0) return null;
  const dir = path.dirname(p0);
  const exeNames = (def.exeNames || []).slice();
  // 从命中路径所在目录起，逐级向上（最多 5 级）找安装根
  let cur = dir;
  for (let up = 0; up < 5; up++) {
    const cliJs = path.join(cur, 'resources', 'app', 'out', 'cli.js');
    if (io.exists(cliJs)) {
      for (let i = 0; i < exeNames.length; i++) {
        const exe = path.join(cur, exeNames[i]);
        if (io.exists(exe)) return { file: exe, head: [cliJs], how: 'exe+cli.js（安装根 ' + cur + '）' };
      }
    }
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  // 命中路径本身就是可执行体（非 VS Code 家族的原生 CLI）
  if (/\.exe$/i.test(p0) && io.exists(p0)) return { file: p0, head: [], how: 'exe 自身' };
  // `.cmd`/`.bat`：**不**为了起它去拼命令行 —— 见函数头
  return null;
}

/**
 * **纯探测**（I/O 由 `io` 注入 ⇒ 可单测、可注入假读数）。
 * @returns `{ at, candidates, associations, errors, stub }`
 */
function probeWith(io, opts) {
  const errors = [];
  const seen = {};                 // exe 绝对路径（小写）→ 已登记的候选下标：**同一条 exe 不重复出现**
  const candidates = [];

  function register(def, hitPath, found) {
    const hit = String(hitPath || '').trim();
    if (!hit) return;
    /* ⚠️ 去重键是 **编辑器 id**，不是命中路径 —— 实测踩过：同一台机器的 Cursor
     *  会从 `path`（无扩展名 shim）与 `registry-scheme`（真 exe）**两条路各进一次**，
     *  按路径去重就会在候选表里出现两行「Cursor」（界面让用户挑两个一样的 ✗）。
     *  合并规则：**保留更强的出处**（path > registry-scheme > app-paths > known-dir）。 */
    const rank = { path: 0, 'registry-scheme': 1, 'app-paths': 2, 'known-dir': 3 };
    if (seen[def.id] !== undefined) {
      if (rank[found] < rank[candidates[seen[def.id]].found]) candidates[seen[def.id]].found = found;
      return;
    }
    const cli = resolveCli(io, def, hit);
    let tier = 'open', jump = { ok: false, why: '没有可用的 CLI（只有 exe / 只有 .cmd 包装）', syntax: '' }, via = 'exe';
    if (cli) {
      const help = io.runHelp(cli.file, cli.head.concat(['--help']), { ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' });
      if (!help.ok) {
        jump = { ok: false, why: 'help 跑不通：' + help.why, syntax: '' };
        errors.push(def.id + '：' + jump.why);
        via = 'exe';
      } else {
        jump = C.parseGotoSupport(help.out);
        if (jump.ok) { tier = 'jump'; via = 'cli'; }
        else { errors.push(def.id + '：CLI 在，但 help 里没有 --goto（⇒ open 档，不假装能跳行）'); via = 'exe'; }
      }
    } else {
      errors.push(def.id + '：只找到 exe / .cmd 包装，起不了 CLI ⇒ open 档（跳行不可用）');
    }
    seen[def.id] = candidates.length;
    candidates.push({
      id: def.id, label: def.label, tier: tier, via: via, found: found,
      // `exe` = **解析出来的可执行体**（有 CLI 时就是真 exe，不是 shim）；`hit` = 探测命的那个路径
      exe: cli ? cli.file : hit, hit: hit,
      scheme: (def.schemes && def.schemes[0]) || '',
      cli: cli ? { file: cli.file, head: cli.head, how: cli.how } : null,
      jump: jump
    });
  }

  // ① PATH
  const all = C.CATALOG;
  for (let i = 0; i < all.length; i++) {
    const names = all[i].pathNames || [];
    for (let j = 0; j < names.length; j++) {
      const hit = io.which(names[j]);
      if (hit) { register(all[i], hit, 'path'); break; }
    }
  }
  // ② 注册表 URL scheme（协议处理器）—— **本机 Trae CN 就是从这里找到的**
  for (let i = 0; i < all.length; i++) {
    const schemes = all[i].schemes || [];
    for (let j = 0; j < schemes.length; j++) {
      if (!schemes[j]) continue;
      const keys = [
        'HKCU\\Software\\Classes\\' + schemes[j] + '\\shell\\open\\command',
        'HKLM\\Software\\Classes\\' + schemes[j] + '\\shell\\open\\command'
      ];
      for (let k = 0; k < keys.length; k++) {
        const r = io.readRegKey(keys[k]);
        if (!r.ok || !r.value) continue;
        const exe = C.exePathFromCommand(r.value);
        if (!exe || !io.exists(exe)) { errors.push(all[i].id + '：注册表里 scheme ' + schemes[j] + ' 指向的 ' + (exe || '(空)') + ' 不在盘上'); continue; }
        register(all[i], exe, 'registry-scheme');
        break;
      }
    }
  }
  // ③ App Paths
  for (let i = 0; i < all.length; i++) {
    const exeNames = all[i].exeNames || [];
    for (let j = 0; j < exeNames.length; j++) {
      const keys = [
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + exeNames[j],
        'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + exeNames[j]
      ];
      for (let k = 0; k < keys.length; k++) {
        const r = io.readRegKey(keys[k]);
        if (!r.ok || !r.value) continue;
        const exe = C.exePathFromCommand(r.value);
        if (exe && io.exists(exe)) { register(all[i], exe, 'app-paths'); break; }
      }
    }
  }
  // ④ 常见落点（最弱）
  const roots = knownDirs(io.env);
  for (let i = 0; i < all.length; i++) {
    const exeNames = all[i].exeNames || [];
    for (let r = 0; r < roots.length; r++) {
      for (let j = 0; j < exeNames.length; j++) {
        const p = path.join(roots[r], exeNames[j].replace(/\.exe$/i, ''), exeNames[j]);
        if (io.exists(p)) { register(all[i], p, 'known-dir'); break; }
        const p2 = path.join(roots[r], exeNames[j]);
        if (io.exists(p2)) register(all[i], p2, 'known-dir');
      }
    }
  }

  // 关联（第 3 件）：扩展名 → ProgId → 命令行
  const associations = {};
  const exts = (opts && opts.extensions) || EXTENSIONS;
  for (let i = 0; i < exts.length; i++) {
    const ext = exts[i];
    const a = io.readRegKey('HKCR\\' + ext);
    const progIdRaw = a.ok ? String(a.value || '').trim() : '';
    /* ⚠️ `reg query <key> /ve` 对"键在、默认值没设"的情况会**成功返回**并把本地化的
     *    `(默认值未设置)` 当成数据印出来 ⇒ 直接拿它当 ProgId 会去查一个不存在的键（本机实测踩到）。
     *    只接受**形状像 ProgId** 的值（字母数字点横线），别的一律当"没关联"。 */
    const progId = /^[A-Za-z0-9_.-]+$/.test(progIdRaw) ? progIdRaw : '';
    let command = '';
    if (progId) {
      const c = io.readRegKey('HKCR\\' + progId + '\\shell\\open\\command');
      if (c.ok) command = String(c.value || '').trim();
    }
    associations[ext] = {
      progId: progId,
      command: command,
      // 没有 ProgId = 这个扩展名**根本没登记关联** ⇒ `assoc-none`（note 档：会弹"选择应用"框）；
      // 有 ProgId 但命令行看不出危害 ⇒ `''`（安静放行）。
      hazard: progId ? C.assocHazard(command, progId) : 'assoc-none'
    };
  }

  return { at: new Date().toISOString(), candidates: candidates, associations: associations, errors: errors, stub: false };
}

/* ---------------- 进程内缓存（**探测很贵**：每条 CLI 都要起一次子进程跑 --help） ---------------- */
const TTL_MS = 5 * 60 * 1000;
let cache = null;

/** 取探测结果（带缓存）；`{force:true}` 强制重探。**失败不缓存**（下次还能好）。 */
function probe(opts) {
  const o = opts || {};
  // 冒烟夹具（照 `MM_ASK_STUB=1` 的先例）：**如实标 stub:true**，绝不冒充真探测结果 ✓
  const fixture = process.env.MM_EDITOR_PROBE_FIXTURE;
  if (fixture) {
    try {
      const j = JSON.parse(fs.readFileSync(fixture, 'utf8'));
      return Object.assign({ at: new Date().toISOString(), candidates: [], associations: {}, errors: [] }, j, { stub: true });
    } catch (e) {
      return { at: new Date().toISOString(), candidates: [], associations: {}, errors: ['夹具读不了：' + e.message], stub: true };
    }
  }
  if (!o.force && cache && (Date.now() - cache.takenAt) < TTL_MS) return cache.value;
  const value = probeWith(o.io || defaultIo(), o);
  cache = { takenAt: Date.now(), value: value };
  return value;
}

/** 清缓存（测试与"用户刚装了编辑器"时用）。 */
function reset() { cache = null; }

return { probe, probeWith, resolveCli, defaultIo, reset, EXTENSIONS, TTL_MS };
});
