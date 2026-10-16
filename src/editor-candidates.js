/* ============================================================
 * src/editor-candidates.js —— 「在编辑器里打开」的**判据唯一实现**（UMD 纯逻辑：零 Electron、零 I/O）
 * ------------------------------------------------------------
 * ## 为什么要有它（用户 2026-10-16 的追加要求）
 *   用户原话：「批 2 既然可以支持 cursor 也应该可以支持 VSC 和 trae 吧，打开的时候给一个可选项」。
 *   实测把这件事拆成两半，**只有一半是缺的**：
 *     · **候选探测**：内核自带 `@deepseek-ai/dsh-host-open-in-app`（固定白名单 catalog，Windows 走
 *       App Paths 注册表）——但它**只服务内置侧栏那一侧**，且 `-g/--goto` 全包 grep **零命中**
 *       ⇒ **不会跳行**；它的白名单里也**没有 Trae**（实测 catalog id：cursor / vscode /
 *       vscodeinsiders / windsurf / zed / sublimetext / sublimemerge / …）。
 *     · **应用侧那条链**（本仓库）：`app:open-file` → `shell.openPath` ⇒ **完全不知道编辑器存在**，
 *       于是本机 `.js` 会被交到 `WScript.exe` 上**执行**（实测 `JSFile=C:\Windows\System32\WScript.exe "%1" %*`）。
 *   ⇒ 本模块 + `src/editor-probe.js` 补的是**应用侧**这一段：运行时探测 + 让用户选 + 能跳行就跳行。
 *
 * ## 三段式（与 `src/path-chain.js` 同形；判据只有一处实现）
 *   ① **探测**（I/O，在 `src/editor-probe.js` 与 `main.js`）：找出本机**真有**的编辑器、各自能不能跳行，
 *      以及 `.js` 这类扩展名**交系统打开会落到哪**；
 *   ② **判据**（本文件，纯函数）：候选 + 用户偏好 → **选谁**、用什么参数（argv 数组）；
 *   ③ **出口**：既有 IPC `app:open-file`（**不新开通道**；本批只给它**多收一个可选参数**）。
 *
 * ## ⭐「不写死」这条纪律到底指什么（判据 ③）
 *   `CATALOG` 只是**搜索目录**（"去哪找"），**不是答案**（"找到了谁"）——
 *   允许写死的只有两类：
 *     · **名字**（哪个 exe 叫 `Cursor.exe` / 哪个 scheme 叫 `cursor`）—— 这是世界的形状；
 *     · **相对布局**（`bin\*.cmd`、`resources\app\out\cli.js`）—— 这是安装器的形状。
 *   **不许写死的是"本机装了什么"**：判断一律来自探测读数（PATH / 注册表 scheme / App Paths / `--help`）。
 *   反面教材就在本机实测里：父代理按"常见落点逐个探"得到「只有 Cursor 有 CLI，Trae CN 没装」，
 *   而**注册表实测 `HKCU\Software\Classes\trae-cn` 存在**、`D:\Program Files\Trae CN\` 里连
 *   `bin\trae-cn.cmd` 带 `resources\app\out\cli.js` 都在 ⇒ **探测目录写死 = 已经在这台机器上漏过一个真编辑器** ✗。
 *   判别力证明见 `tests/editor-probe.test.js`：把探测读数换成"只命中注册表里那条 Trae CN"⇒ 断言必须红。
 *
 * ## 两档（**必须分清，界面要响亮标注**）
 *   | 档 | 判据 | 界面怎么说 |
 *   |---|---|---|
 *   | `jump` | 有 CLI，且**它的 `--help` 自己声明** `--goto <file:line[:character]>` | 「可打开并跳到第 N 行」|
 *   | `open` | 只有 exe / 只有 URL scheme / CLI 存在但 help 里没有 `--goto` | 「**只能打开**（跳不了行）」 |
 *   ⚠️ 本机实测（2026-10-16）：`cursor 3.24.18` 与 `Trae CN 3.4.3` **都**在 `--help` 里印了
 *      `-g --goto <file:line[:character]>`（stdout 实捕获、exit 0）⇒ 两个都是 `jump` 档。
 *      `cursor://` 与 `trae-cn://` 两个 URL scheme **已注册**，但"带行号的 URL 会不会真的跳"**没有读数**
 *      （实测：发一次 URL 后 Cursor 的状态/日志里**没有**出现那个文件）⇒ URL scheme 一律记 `open` 档，
 *      **不许**拿它冒充跳行 ✗。理由与读数见 `.review/20261016-改动清单面板/README.md`。
 *
 * ## 安全面（为什么 argv 是数组、为什么不做命令拼接）
 *   `commandArguments()` 返回的是 **argv 数组**（`['--goto', 'C:\x\a.js:12']`），出口那一侧直接
 *   `spawn(exe, argv)` —— **全程没有一次字符串拼命令行** ⇒ 路径里带 `&`、空格、引号都不会变成命令。
 *   这不是"顺手做对"，是本批的硬纪律（任务书：**不许拼命令行字符串 —— 注入面**）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMEditorCandidates = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 两档（**闭环保值表**：表外的值必须响亮拿到 reject，不许静默按默认档走）。 */
  const TIERS = ['jump', 'open'];

  /** 档 → 界面文案（**唯一一处**；调用方只显示、不自拼）。 */
  const TIER_TEXT = {
    jump: '可打开并跳到指定行',
    open: '只能打开（跳不了行）'
  };

  /* ---------------- 搜索目录（**不是答案**，见文件头"不写死"那一节） ----------------
   * 一行 = 一个候选。字段含义：
   *   id        稳定标识（用户偏好与日志用它；**改名 = 破坏已记住的选择**）
   *   label     界面显示名
   *   schemes   **该编辑器注册的 URL scheme**（探测面：注册表 HKCU/HKLM\Software\Classes\<scheme>）
   *   pathNames PATH 上的 CLI 名（探测面：`where`）
   *   exeNames  **exe 文件名**（探测面：App Paths 注册表 + 已知落点；**也是从 scheme 反查时的匹配键**）
   *   cliNames  该 exe 对应的 CLI 包装脚本名（不含扩展名；`code.cmd` / `cursor.cmd` / `trae-cn.cmd`）
   */
  const CATALOG = [
    { id: 'cursor', label: 'Cursor', schemes: ['cursor'], pathNames: ['cursor'], exeNames: ['Cursor.exe'], cliNames: ['cursor'] },
    { id: 'vscode', label: 'VS Code', schemes: ['vscode'], pathNames: ['code'], exeNames: ['Code.exe'], cliNames: ['code'] },
    { id: 'vscode-insiders', label: 'VS Code Insiders', schemes: ['vscode-insiders'], pathNames: ['code-insiders'], exeNames: ['Code - Insiders.exe'], cliNames: ['code-insiders'] },
    { id: 'trae', label: 'Trae', schemes: ['trae'], pathNames: ['trae'], exeNames: ['Trae.exe'], cliNames: ['trae'] },
    { id: 'trae-cn', label: 'Trae CN', schemes: ['trae-cn'], pathNames: ['trae-cn'], exeNames: ['Trae CN.exe'], cliNames: ['trae-cn'] },
    { id: 'windsurf', label: 'Windsurf', schemes: ['windsurf'], pathNames: ['windsurf'], exeNames: ['Windsurf.exe'], cliNames: ['windsurf'] },
    { id: 'zed', label: 'Zed', schemes: ['zed'], pathNames: ['zed'], exeNames: ['Zed.exe'], cliNames: ['zed'] },
    { id: 'sublime', label: 'Sublime Text', schemes: [''], pathNames: ['subl'], exeNames: ['sublime_text.exe'], cliNames: ['subl'] }
  ];

  const CATALOG_IDS = CATALOG.map(function (e) { return e.id; });

  /** 按 id 取候选定义（探测侧用它把"注册表里发现的 exe"对回名字）。 */
  function byId(id) {
    for (let i = 0; i < CATALOG.length; i++) if (CATALOG[i].id === id) return CATALOG[i];
    return null;
  }

  /** 按 exe 文件名取候选定义（大小写不敏感；**从注册表反查时用它**）。 */
  function byExeName(exePath) {
    const base = String(exePath || '')
      .replace(/^.*[\\/]/, '')      // 目录
      .replace(/^"|"$/g, '')        // 注册表命令里可能带引号
      .trim()
      .toLowerCase();
    for (let i = 0; i < CATALOG.length; i++) {
      const names = CATALOG[i].exeNames;
      for (let j = 0; j < names.length; j++) if (names[j].toLowerCase() === base) return CATALOG[i];
    }
    return null;
  }

  /** 从"注册表里的那条命令行"取 exe 路径（`"D:\...\Cursor.exe" --open-url -- "%1"` → 第一个引号组）。
   *  纯字符串处理：**不做 shell 解析**、不执行任何东西。
   *  ⚠️ 两种形态都要吃（实测都出现过）：**带引号**的（URL scheme handler 常见）与
   *  **不带引号但路径里有空格**的（App Paths 常见：`C:\Program Files\Microsoft VS Code\Code.exe`）
   *  —— 第一版只写了 `^(\S+\.exe)`，后者直接解析成空串 ⇒ 那一档静默失效（被单测抓红）。 */
  function exePathFromCommand(command) {
    const s = String(command || '').trim();
    if (!s) return '';
    const q = /^"([^"]+)"/.exec(s);
    if (q) return q[1];
    const t = /^(.+?\.exe)(?=\s|$)/i.exec(s);   // 非贪婪：允许路径里有空格，止于 `.exe`
    return t ? t[1] : '';
  }

  /* ---------------- 跳行能力的**判据**：CLI 自己有没有声明 --goto ----------------
   * 为什么解析 `--help` 而不是写一张"哪些编辑器支持 goto"的表：
   *   · 写表 = 把"编辑器支不支持"变成我们的**声明**，编辑器升级改了参数我们**不会知道**；
   *   · 解析 help = 拿**产品自己的输出**当读数，升级后参数变了 ⇒ 自动降级成 `open` 档（响亮，不静默）。
   * 实测两个来源的原文（本机 2026-10-16）：
   *   Cursor 3.24.18 / Trae CN 3.4.3 都有这一行：
   *     `-g --goto <file:line[:character]>   Open a file at the path on the specified line and character position.`
   */
  function parseGotoSupport(helpText) {
    const text = String(helpText || '');
    if (!text) return { ok: false, why: 'help 为空（拿不到读数）', syntax: '' };
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/--goto\b/.test(lines[i])) continue;
      const m = /<([^>]*line[^>]*)>/i.exec(lines[i]);
      return { ok: true, why: '', syntax: m ? '<' + m[1] + '>' : '<file:line[:character]>', evidence: lines[i].trim() };
    }
    return { ok: false, why: 'help 里没有 --goto', syntax: '' };
  }

  /* ---------------- 安装目录 → CLI 的**相对布局**（世界的形状，允许写死） ----------------
   * VS Code 家族（Cursor / Trae CN / Windsurf …）实测布局：
   *   <dir>\<Name>.exe
   *   <dir>\bin\<cli>.cmd            ← 包装脚本：set ELECTRON_RUN_AS_NODE=1 → <exe> <dir>\resources\app\out\cli.js %*
   *   <dir>\resources\app\out\cli.js ← CLI 本体
   * 返回**候选路径数组**（探测侧逐个 existsSync；都不在 ⇒ 还没到放弃的时候，见 probe 里的 bin 目录兜底）。
   */
  function layoutOf(exePath, cliNames) {
    const exe = String(exePath || '');
    if (!exe) return { dir: '', binCmd: [], cliJs: '' };
    const sep = exe.indexOf('\\') >= 0 ? '\\' : '/';
    const dir = exe.replace(/[\\/][^\\/]*$/, '');
    const names = (cliNames && cliNames.length ? cliNames : []).slice();
    // exe 名本身也当一次候选（`subl.exe` 这类 CLI 与 exe 同名）
    names.push(exe.replace(/^.*[\\/]/, '').replace(/\.exe$/i, ''));
    const binCmd = [];
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      binCmd.push(dir + sep + 'bin' + sep + n + '.cmd');
      binCmd.push(dir + sep + 'bin' + sep + n + '.exe');
    }
    return { dir: dir, binCmd: binCmd, cliJs: dir + sep + 'resources' + sep + 'app' + sep + 'out' + sep + 'cli.js' };
  }

  /* ---------------- 判据：选谁（纯函数；**唯一的"选编辑器"实现**） ----------------
   * 输入：
   *   candidates —— **探测读数**（`[{id, label, tier, cli:{file,args}|null, exe, scheme, via, jump}]`），
   *                 顺序 = 探测给出的顺序（调用方保证稳定，例如按 catalog 顺序 + 发现顺序）；
   *   preference —— 用户上次选的 id（可为空；**界面记住的那一个**）。
   * 输出：`{ candidate, why }` 或 `{ candidate:null, why }`。
   * 优先级（**这是本批的行为契约**）：
   *   ① 偏好命中且**这次也探到了** ⇒ 用它（**用户选择优先**）；
   *   ② 否则取**第一个 `jump` 档**（能跳行 > 不能，且用户要的就是跳行）；
   *   ③ 否则取**第一个 `open` 档**；
   *   ④ 都没有 ⇒ `null`（出口**响亮降级**到 `shell.openPath`，绝不说"跳了"✗）。
   * ⚠️ **偏好命中的但已经不在**（用户卸载了它）⇒ **不静默回落到别的档**就算了：`why` 里说明，
   *    出口把这件事显示出来（"上次选的 X 不在了"），用户才知道为什么变了 ✗ 不猜。
   */
  function choose(candidates, preference) {
    const list = Array.isArray(candidates) ? candidates.filter(function (c) { return c && c.id; }) : [];
    if (preference) {
      for (let i = 0; i < list.length; i++) {
        if (list[i].id === preference) return { candidate: list[i], why: 'user-preference', stalePreference: null };
      }
      for (let i = 0; i < list.length; i++) if (list[i].tier === 'jump') return { candidate: list[i], why: 'preference-gone-jump-first', stalePreference: preference };
      for (let i = 0; i < list.length; i++) if (list[i].tier === 'open') return { candidate: list[i], why: 'preference-gone-open', stalePreference: preference };
      return { candidate: null, why: 'preference-gone-nothing-detected', stalePreference: preference };
    }
    for (let i = 0; i < list.length; i++) if (list[i].tier === 'jump') return { candidate: list[i], why: 'first-jump', stalePreference: null };
    for (let i = 0; i < list.length; i++) if (list[i].tier === 'open') return { candidate: list[i], why: 'first-open', stalePreference: null };
    return { candidate: null, why: 'nothing-detected', stalePreference: null };
  }

  /** 行号规范化：`null`/`undefined`/0/负数/非数 ⇒ **不带行号**（返回 null）；
   *  只保留正整数（第 1 行是 1；**0 不许被当成"第 0 行"**，那是未提供）。 */
  function normalizeLine(line) {
    const n = Number(line);
    if (!isFinite(n)) return null;
    const i = Math.floor(n);
    return i >= 1 ? i : null;
  }

  /**
   * CLI 档的**调用参数**（**argv 数组，绝不拼字符串**）。
   * @returns `{ file, args }`（`file` = 可执行体，`args` = 参数数组）或 `null`（该候选没有 CLI）。
   * 形态（实测两个 CLI 的 `--help` 都这么声明）：
   *   `<cli> --goto <file>:<line>[:<col>]`   ← 无行号时退化成只给文件路径（**不编造第 1 行**）
   * ⚠️ `--reuse-window` **不加**：实测它存在（`-r --reuse-window` 原文"Force to open a file or folder in
   *    an already opened window"），但**没有任何读数**说明"加了它对跳行更可靠" ⇒ 按纪律**不猜**，
   *    保持最小参数面（写在这里，免得下一个人以为漏了）。
   */
  function commandArguments(candidate, abs, line, col) {
    if (!candidate || !candidate.cli || !candidate.cli.file) return null;
    const target = String(abs || '');
    if (!target) return null;
    const ln = normalizeLine(line);
    const args = [];
    if (ln !== null) {
      const c = normalizeLine(col);
      args.push('--goto', target + ':' + ln + (c !== null ? ':' + c : ''));
    } else {
      args.push(target);
    }
    return { file: candidate.cli.file, args: args, head: candidate.cli.head || [], jumped: ln !== null && candidate.tier === 'jump' };
  }

  /** URL scheme 档的目标（`open` 档用；**跳行未验证** ⇒ `jumped` 恒为 false）。 */
  function schemeTarget(candidate, abs, line, col) {
    if (!candidate || !candidate.scheme) return null;
    const target = String(abs || '').replace(/\\/g, '/');
    if (!target) return null;
    // 带行号的 URL 形态照 VS Code 家族的既有形状拼（`<scheme>://file/<path>:<line>:<col>`），
    // 但**它到底会不会跳没有读数** ⇒ 返回值里如实标 `jumped:false`，界面按 `open` 档显示 ✗。
    const ln = normalizeLine(line);
    const c = normalizeLine(col);
    return {
      url: candidate.scheme + '://file/' + target + (ln !== null ? ':' + ln + (c !== null ? ':' + c : '') : ''),
      jumped: false
    };
  }

  /* ---------------- 第 3 件：`.js` 这类扩展名"交系统打开"会落到哪 ----------------
   * 实测（本机 2026-10-16，`assoc`/`ftype`/注册表三处读数一致）：
   *   .js  → JSFile → `C:\Windows\System32\WScript.exe "%1" %*`  ⇒ **打开 = 执行脚本** ✗✗
   *   .ts  → WMP11.AssocFile.TTS → Windows Media Player              ⇒ 打开 = 放媒体 ✗
   *   .md / .markdown / .json / .mjs / .cjs → **没有关联** ⇒ 落到系统选择框（不是"打不开"，但也不是好体验）
   * ⇒ 危险关联**分档**：`exec`（执行）与 `media`（放媒体）都**必须响亮标注**，
   *    而 `exec` 档更进一步 —— **不许把 .js 交出去**（任务书："不许把 .js 交给 WScript"）。
   */
  const HAZARDS = {
    'assoc-exec': {
      level: 'block',
      text: '本机把这个扩展名关联到了**脚本宿主**（WScript）——「交系统打开」会**执行**它，不是显示内容。'
        + '已拦下。要显示内容：装一个编辑器（VS Code / Cursor / Trae），或把该扩展名改成用编辑器打开。'
    },
    'assoc-media': {
      level: 'block',
      text: '本机把这个扩展名关联到了**媒体播放器**（如 TypeScript 的 .ts 被当成 MPEG 传输流）——'
        + '「交系统打开」会拿播放器去放它。已拦下。要显示内容：装一个编辑器，或改该扩展名的默认应用。'
    },
    'assoc-none': {
      level: 'note',
      text: '本机没有给这个扩展名登记关联 ⇒ 交系统打开会弹出「选择应用」框（不是打不开，但每次都要选）。'
    }
  };

  /** 从"关联命令行 + ProgId"判危害档（纯字符串；两个输入都来自探测读数）。
   *  ⚠️ 判据为什么**不能只列播放器名字**：本机实测第一版只认 `wmplayer.exe`，而 `.ts` 实际关联的是
   *     `PotPlayerMini64.TS`（PotPlayer）⇒ 漏判。**列名字永远列不完** ⇒ 改成两条"形状"判据：
   *       ① 命令行指向**脚本宿主**（`wscript`/`cscript`）—— 语义就是"执行它"，最危险；
   *       ② ProgId 是**某个应用抢注的媒体类型**：带 `AssocFile` 前缀（Windows 自家的媒体关联命名，
   *          实测 WMP 的 `.ts` 是 `WMP11.AssocFile.TTS`）**或**以媒体扩展名结尾
   *          （实测 PotPlayer 的 `.ts` 是 `PotPlayerMini64.TS`）—— 这两种形状都表示"某个播放器
   *          把源文件扩展名当媒体类型占了"。
   *     名字表只留作**补充**（`potplayer|vlc|mpc-hc|mpv|kmplayer`），不作为唯一判据。 */
  function assocHazard(command, progId) {
    const s = String(command || '').toLowerCase();
    const p = String(progId || '');
    if (/wscript(\.exe)?\b/.test(s) || /cscript(\.exe)?\b/.test(s)) return 'assoc-exec';
    if (/wmplayer\.exe\b/.test(s) || /microsoft\\?windows\\?media/.test(s)) return 'assoc-media';
    if (/(potplayer|vlc|mpc-hc|mpv|kmplayer|kmplayer64)/.test(s)) return 'assoc-media';
    if (/AssocFile/i.test(p)) return 'assoc-media';
    if (/\.(TS|MP4|MKV|AVI|MOV|MPG|RMVB|FLV)$/i.test(p) && !/^\.?(txt|html)/i.test(p)) return 'assoc-media';
    return '';
  }

  /** 危害档 → 人话（**唯一一处文案**；`''`/未知档 ⇒ `''`，调用方不显示）。 */
  function hazardText(code) {
    return (HAZARDS[code] && HAZARDS[code].text) || '';
  }

  /** 危害档 → 处理级别：`block` = **不放行给系统**；`note` = 放行但要说；`''` = 没事。 */
  function hazardLevel(code) {
    return (HAZARDS[code] && HAZARDS[code].level) || '';
  }

  /** 候选列表 → 界面行（选择菜单与状态栏共用**这一份**文案）。 */
  function summarize(candidates) {
    const list = Array.isArray(candidates) ? candidates : [];
    return list.map(function (c) {
      return {
        id: c.id,
        label: c.label + '（' + (TIER_TEXT[c.tier] || c.tier) + '）',
        tier: c.tier,
        tierText: TIER_TEXT[c.tier] || c.tier,
        via: c.via,
        found: c.found || ''
      };
    });
  }

  return {
    // 取值表与文案（调用方只显示，不自拼）
    TIERS: TIERS, TIER_TEXT: TIER_TEXT, HAZARDS: HAZARDS,
    CATALOG: CATALOG, CATALOG_IDS: CATALOG_IDS,
    byId: byId, byExeName: byExeName, exePathFromCommand: exePathFromCommand,
    parseGotoSupport: parseGotoSupport, layoutOf: layoutOf,
    // 判据
    choose: choose, normalizeLine: normalizeLine,
    commandArguments: commandArguments, schemeTarget: schemeTarget,
    assocHazard: assocHazard, hazardText: hazardText, hazardLevel: hazardLevel,
    summarize: summarize
  };
});
