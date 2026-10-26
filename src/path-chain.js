/* ============================================================
 * src/path-chain.js — 「路径 → 打开 / 预览」的**唯一判据处**（UMD 纯逻辑：零 Electron、零 I/O）
 * ------------------------------------------------------------
 * ## 三段式契约（这条链的**全部**内容）
 *   ① **解析**：原始输入（节点里的相对路径 / `localPath` 绝对路径 / 正文里的路径 / **`http(s)` 网址**）
 *       → 规范产物 `abs`（路径类 = 规范绝对路径；`externalUrl` = `new URL().href`）；
 *   ② **判据**：`decide({kind, raw, project, force})` → `{ok, abs, reason, action, code, kind}`
 *      （`action ∈ {preview, system, external, reject}` —— 取值表就是本文件的 `ACTIONS`）；
 *   ③ **出口只有一个**：既有 IPC `app:open-file`（`main.js`；**不新开 IPC 名字** ——
 *      本批只把签名**多收一个可选参数** `opts.kind`，由 `EXIT_KINDS` 这张表决定按哪一档再守一道）。
 *   本模块只做 ①②；③ 在调用方（`renderer/app-media.js` / `renderer/app-detail-content.js` /
 *   `main.js` 的出口守卫），它们**一个字都不许再判一遍**。
 *   ⚠️ **本批补了第 ③ 段的"动作选择"**（`OPEN_MODES` / `openPlan` / `openAsCommand`）：
 *     判据决定"能不能开"，动作决定"**用哪个 API 开**"（系统默认程序 / 系统「打开方式」选择栏 /
 *     文件资源管理器定位）。这一层**仍然是纯函数**，I/O 全在 `main.js` 的 `execOpenPlan` ——
 *     理由见下面 `OPEN_MODES` 那张表（"打开方式被写成再打开一次"这种假实现必须能被机械判定）。
 *
 * ## 判据（**只有这一份实现**）
 *   | # | 判据 | 落法 |
 *   |---|------|------|
 *   | 1 | **禁 `..` 逃逸** | 相对路径类（`attachment` / `image` / `inline`）拼出 `abs` 后**规范化**，必须仍落在
 *   |   |                | 当前项目目录**之内**；否则 `action:'reject'` + `code:'path-escape'` |
 *   | 2 | **禁 UNC / 设备路径** | `\\?\`、`\\.\`、`\\server\share`、`//host/share` 一律 reject（`code:'path-unc-device'`），
 *   |   |                        | **只按形状判、不做任何存在性探测** —— 本机 `X:` 是不可达映射网络盘，
 *   |   |                        | 一句 `fs.existsSync` 要 9–21 秒 ⇒ 判据里**一次 I/O 都不许有** |
 *   | 3 | **打不开必须显式报错** | reject **一定**带非空 `reason`（`REASONS[code]`，唯一一处文案）；调用方负责
 *   |   |                          | 把它显示出来 —— 先例口径 `docs/DATA-FORMAT.md`「点开会明确报错，不会静默没反应」 |
 *   | 4 | **`localPath` 单独一档** | 它**本来就是工作区外的绝对路径**，`docs/DATA-FORMAT.md` §2.1 规定
 *   |   |                          | **只校验形状**（非空 / 无换行 / ≤500 字符）、**不校验存在性** ⇒ **不许**拿"必须在项目内"
 *   |   |                          | 去卡它（那会把今天能打开的 `localPath` 全部打不开）；`action` 恒为 `system` |
 *   | 5 | **`action` 与改动前逐条等价或更严** | 绝不更松。等价性由**全量对拍**证：
 *   |   |                                    | `node scripts/pathchain-conformance.js`（差异必须 = 0）|
 *   | 6 | **`http(s)` 只放行、别的协议一律拒** | `externalUrl` 一档：`new URL()` 解得开 → 协议**白名单**（`http:`/`https:`）
 *   |   |                                    | → 不许带凭据；`action` 恒为 `external`（交系统浏览器）。
 *   |   |                                    | `file:`/`javascript:`/`data:`/`vbscript:`/`blob:`/`aimm:` 与畸形串**全部** reject + 非空 reason |
 *
 * ## 这一档为什么进来（R7 的"声称有、实测没有"）
 *   R7 设计稿 §4-1 说 `http(s)` 链接"**一律交系统默认浏览器打开**"，而 R7 实现时实测**本工程没有那个出口**
 *   （唯一出口只收本机绝对路径）⇒ 当时只能"拦下 + 状态栏点名"。**本批把这条缺口补成真能力**，
 *   形状选择是**并进这条链**（新增 `kind:'externalUrl'` + `action:'external'`）而不是新开一条 IPC：
 *   `shell.openExternal` 是 Electron 安全清单点名的高危面（**不许**对不可信内容用）⇒ 它前面必须有一道
 *   判据；而"这道判据应该长在哪"只有一个正确答案 —— **和路径判据同一处**。否则同一个"点一下东西出去"
 *   的动作会有两份判据、两个出口，正是本工程反复治过的病。
 *
 * ## 为什么要有它（改动前的四处、四套判据）
 *   · `renderer/app-media.js` 的 `attachmentAbsPath` —— 只拼字符串（`base + '/' + rel`），**零校验**；
 *   · `renderer/app-media.js` 的预览头 —— 「系统打开」与「🔗 本机」各自决定走哪条路；
 *   · `renderer/app-detail-content.js` 的 `openLocalPath`（详情框链接 / 右键菜单 / 预览头共用）—— 原样交主进程；
 *   · `renderer/app-detail-content.js` 的图片区 —— `'../projects/' + name + '/' + img.file`，同样零校验。
 *   ⇒ `..` 逃逸、UNC、设备路径**全部不判**，而"打不开"在几处是**静默**的。
 *
 * ## 与内置 DSH 的 Session 授权口径的关系（**同形不同主体**，不是两套概念）
 * DSH 宿主文件面按 **Session** 授权：地址 `dsh-resource://file/session/<sessionId>/<path>`；
 * 它接受绝对路径或相对工作区根的路径、**读**不额外要求限定在工作区内（只有**列目录 / 监听**限定，
 * 越界报 `workspace-file/outside-workspace`），并拒绝**末端符号链接**、有 32 MiB / 5000 行上限。
 * 本模块是**同一个形状**（解析 → 判据 → 出口），**授权主体换成「当前项目」**。
 * ⚠️ 两条**刻意的差异**，别当成"没对齐"：① 主体是当前项目而不是 Session；
 * ② 本模块**不做 I/O**，所以没有"末端符号链接拒绝 / 大小上限 / UTF-8 校验"那三条 ——
 * 它们是**读取侧**的口径，我们的读取侧是 `app:read-file`（`fs.readFileSync`），本批一个字节没动。
 *
 * ## 与 `src/bundle.js` 的 `isSafeRelPath` 的关系（如实登记，**本批不合并**）
 * 那个是**打包格式**（aimap bundle 解包时防"写出项目外"）的防御，判据是 `path.resolve` 后的前缀比较，
 * 属于**数据层**；本模块是**打开链**的判据（输入是节点字段与用户给的路径）。两者不同源、不同层；
 * 合并要先量两者对边界样本的差异 ⇒ 本批不动它，在此点名免得后人以为漏了一处。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMPathChain = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 允许的 `kind`（闭环取值表：传表外的值**响亮拿到 reject**，不是静默按某个默认档走） */
  const KINDS = ['attachment', 'image', 'inline', 'localPath', 'system', 'externalUrl'];

  /** `action` 取值表。`external` 是**交系统浏览器**那一档（只对 `externalUrl` 生效），
   *  与 `system`（交系统**关联程序打开本机文件/目录**）分开：两者出口机制不同
   *  （`shell.openExternal(url)` vs `shell.openPath(路径)` + 编辑器档），
   *  合并成一档会让出口 handler 只能靠"猜输入形状"分流 = 第二份判据。 */
  const ACTIONS = ['preview', 'system', 'external', 'reject'];

  /** 出口 handler（`app:open-file`）允许收的 `kind`：**只有这两档**能到出口。
   *  ⚠️ 这是**出口那一侧的取值表**，由本模块给出、`main.js` 不许自己再列一份
   *  （否则"哪几档能到出口"这件事就有了两处表达）。传表外的值 ⇒ handler 按 `system` 处理。 */
  const EXIT_KINDS = ['system', 'externalUrl'];

  /** `externalUrl` 的**协议白名单**（唯一一处）。只放这两个 —— 照 Electron 安全清单：
   *  `shell.openExternal` **不许**对不可信内容用，所以行不行由这里判，出口只负责"照做"。 */
  const ALLOWED_URL_PROTOCOLS = ['http:', 'https:'];

  /** 走**内预览**的扩展名：`md` 内联渲染、`pdf` 内嵌 iframe（`renderer/app-media.js` 的两条既有预览路）；其余交系统 */
  const PREVIEW_EXTS = ['md', 'markdown', 'pdf'];

  /** `localPath` 的长度上限（`docs/DATA-FORMAT.md` §2.1 与 `src/schema.js` 同一口径） */
  const LOCAL_PATH_MAX = 500;

  /* ================= 第 ③ 段的**动作表**：到了出口之后，用哪个 API 去"打开" =================
   * 【文件链接的打开语义批】`localPath` 从"目录快捷方式"扩成"**本机文件或目录**"之后，
   * "打开"这一个词在界面上其实是三种**不同的用户意图**（用户 2026-10-31 的裁定：左键点文件链接
   * 要用系统默认程序开、没默认才弹"打开方式"；右键要能把"打开 / 打开方式 / 在资源管理器里打开"分开）：
   *
   *   | mode | 用户意图 | 用哪个 API | 关键事实 |
   *   |------|---------|-----------|---------|
   *   | `default` | 既有行为：先试探测到的编辑器 | `main.js` 的 `openWithEditor` | 本批**一个字不改**（既有调用方不传 mode ⇒ 走到这里）|
   *   | `system`  | 系统默认程序打开 | `shell.openPath` | 文件：有默认关联就直接开；**没有关联时 Windows 自己弹"打开方式"选择栏**（ShellExecuteEx 的原生行为）⇒ 我们**绝不自己查默认关联**（那既是重复实现 Windows、也查不准）。目录：开文件管理器（既有行为）|
   *   | `openAs`  | **系统"打开方式"选择栏** | `rundll32.exe shell32.dll,OpenAs_RunDLL "<路径>"` | `shell.openPath` 用的是 `open` 动词，**做不到**这件事 |
   *   | `reveal`  | **在文件资源管理器里定位** | 文件 ⇒ `shell.showItemInFolder`（**选中**它）；目录 ⇒ `shell.openPath`（打开那个目录） | 文件若也去 `openPath`，那是"打开文件"而不是"定位它" |
   *
   * ⚠️ 这三档**必须真的分叉**，不许都落到 `shell.openPath`：那样"打开方式"会变成"再打开一次"、
   *   "定位"会变成"打开" —— 两种都是**测试看着绿、用户要的东西没出现**的假实现
   *   （判据：`tests/local-open-actions.test.js` + `scripts/smoke/16-local-path.js`，
   *    且断言比的是**行为差异**（哪个执行器跑了 / argv 是什么），不是"有没有报错"）。
   * ⚠️ 取值表**只有这一份**（与 `EXIT_KINDS` 同一族：那管"哪几档能到出口"，这管"到了出口做什么"）——
   *   `main.js` 与渲染层都**不许**各列一份自己的清单。 */
  const OPEN_MODES = ['default', 'system', 'openAs', 'reveal'];

  /** 相对路径类：必须落在**当前项目目录**之内 */
  const RELATIVE_KINDS = ['attachment', 'image', 'inline'];

  /** 绝对路径类：**只校验形状**，不校验在不在项目里（`localPath` 天然在项目外） */
  const ABSOLUTE_KINDS = ['localPath', 'system'];

  /** `code` → 人话（**唯一一处文案**；`reason` 由它现取，调用方只显示、不自己拼报文）。
   *  ⚠️ code 一律带 `path-` 前缀：它是**机器可读标识**，无前缀会与别处的状态串撞名
   *  （实测：`renderer/app-bindings.js` 就有一个无关的 `'no-project'`）⇒ 撞名会让
   *  "判据只有一处实现"这条结构断言**看起来**被破（假红），也会让真读者分不清谁是谁。 */
  const REASONS = {
    'path-unknown-kind': '未知的路径类型（kind 取值不在 src/path-chain.js 的 KINDS 内）',
    'path-not-string': '路径不是字符串',
    'path-empty': '路径为空',
    'path-control-char': '路径含控制字符（换行 / NUL 等），不接受',
    'path-unc-device': '不接受 UNC / 设备路径（\\\\?\\、\\\\.\\、\\\\server\\share 一律拒绝）',
    'path-no-project': '缺少项目路径（界面还不知道当前项目，算不出相对路径的根）',
    'path-not-relative': '必须是项目内的**相对路径**（不接受绝对路径 / 盘符 / 前导斜杠）',
    'path-not-absolute': '必须是**本机绝对路径**（形如 E:\\目录）',
    'path-escape': '路径逃出了项目目录（规范化后已不在当前项目之内，疑似 .. 逃逸）',
    'path-self': '这是项目目录本身，不是一个文件',
    'path-too-long': '路径过长（超过 500 字符）',
    /* ---- `externalUrl` 那一档（本批新增）的三条：**protocol 白名单是唯一的放行开关** ----
     * ⚠️ 这里**刻意没有** `path-url-no-host` 这一档：取证（`.review/20261016-外部链接出口/tools/url-probe-no-host.js`）
     *   证明它**不可达** —— http:/https: 是 WHATWG 的 special scheme，解析器要么给出**非空** host，
     *   要么直接抛 `ERR_INVALID_URL`（20 条畸形形状实测"白名单内且 host 为空"= **0 条**）。
     *   加一条永远打不出来的 reject = 让人以为守住了 = 本工程最重的损害类别 ⇒ 不加。 */
    'path-url-malformed': '这个网址解析不了（`new URL()` 失败：形状不完整或有非法字符），不接受',
    'path-url-scheme': '这个协议不在放行名单里（只放行 http: / https:；file: / javascript: / data: / vbscript: / blob: 等一律拒绝）',
    'path-url-credentials': '网址里带账号密码（形如 http://user:pass@host/…），不接受'
  };

  function isString(v) { return typeof v === 'string'; }

  /** 项目 JSON 的绝对路径 → 项目目录（**唯一一处**；算式与改动前 `attachmentAbsPath` 的逐字相同） */
  function projectDirOf(projectFile) {
    return String(projectFile).replace(/[\\/][^\\/]+$/, '');
  }

  /** 取扩展名（小写；无扩展名 ⇒ ''）。**只用于 `action` 分档**，不参与"能不能开"的判定 */
  function extOf(raw) {
    const base = String(raw).split(/[\\/]/).pop();
    const i = base.lastIndexOf('.');
    return (i > 0 && i < base.length - 1) ? base.slice(i + 1).toLowerCase() : '';
  }

  /** UNC / 设备路径：`\\?\`、`\\.\`、`\\server\share`、`//host/share` 的共同形状 = 两个前导分隔符 */
  function isUncOrDevice(raw) { return /^[\\/]{2}/.test(String(raw)); }

  /** 控制字符（含 CR / LF / NUL / DEL）—— 换行进路径一定是坏的（与本工程"字段不能含换行"同一口径） */
  function hasControlChar(raw) { return /[\u0000-\u001f\u007f]/.test(String(raw)); }

  /** 盘符绝对路径（`E:\…` 或 `E:/…`） */
  function isDriveAbsolute(raw) { return /^[A-Za-z]:[\\/]/.test(String(raw)); }

  /** 绝对样的（盘符 / 前导斜杠 / 裸盘符）—— 用于相对路径类的"不许给绝对路径"判定 */
  function isAbsoluteLike(raw) {
    const s = String(raw);
    return isDriveAbsolute(s) || /^[\\/]/.test(s) || /^[A-Za-z]:$/.test(s);
  }

  /**
   * 归一化（**只用于判据**，绝不用于产出 `abs` —— 产出的 `abs` 必须与改动前逐字相同）。
   * `/`→`\`、丢掉 `.` 段、就地折叠 `..`；折不动时**保留字面 `..`** ⇒ "逃到盘根之上"必然撞判据。
   * 不碰盘、不解析符号链接、不查存在性。
   */
  function normalizeForJudge(p) {
    const s = String(p).replace(/\//g, '\\');
    let head = '';
    let rest = s;
    const m = /^([A-Za-z]:)\\*/.exec(s);
    if (m) {
      head = m[1] + '\\';
      rest = s.slice(m[0].length);
    } else if (s[0] === '\\') {
      head = '\\';
      rest = s.replace(/^\\+/, '');
    }
    const segs = [];
    rest.split('\\').forEach(function (seg) {
      if (!seg || seg === '.') return;
      if (seg === '..') {
        if (segs.length && segs[segs.length - 1] !== '..') segs.pop();
        else segs.push('..');
        return;
      }
      segs.push(seg);
    });
    return head + segs.join('\\');
  }

  /**
   * 页面相对地址（`renderer/` 是页面根）—— **唯一一处**拼这个串的地方。
   * 算式与改动前 `renderer/app-detail-content.js` 图片区那一行**逐字相同**
   * （`'../projects/' + name + '/' + file`）：`<img src>` 走的是页面相对地址而不是绝对路径
   * （直接换 `file://` 会改 DOM 字节、动到真帧断言），所以这一形态由本模块一起给出，
   * 调用方**不许**再自己拼（那就是第二份解析）。
   */
  function rendererUrlOf(project, raw) {
    return (project && project.name) ? ('../projects/' + project.name + '/' + raw) : String(raw);
  }

  /** `action` 分档（**唯一一处**）：图片恒内预览；md/pdf 内预览；其余交系统 */
  function actionFor(kind, raw) {
    if (kind === 'image') return 'preview';
    if (kind === 'attachment' || kind === 'inline') {
      return PREVIEW_EXTS.indexOf(extOf(raw)) >= 0 ? 'preview' : 'system';
    }
    return 'system';
  }

  /**
   * 判据入口（纯函数：同一输入恒等输出，不读时钟、不碰盘、不抛错）。
   *
   * @param {{kind:string, raw:*, project?:{file?:string,name?:string}, force?:'system'}} input
   *   `kind`   —— `KINDS` 之一（`attachment`=节点 `files[].file`；`image`=节点 `images[].file`；
   *               `inline`=正文里的路径（R7 用，本批不消费、判据已备好）；`localPath`=节点里的本机目录；
   *               `system`=已经解析好的绝对路径，交给**出口**再守一道；
   *               `externalUrl`=正文里的 `http(s)` 网址（**本批新增**，`action:'external'` = 交系统浏览器））
   *   `raw`    —— 原始输入（**不 trim、不改写**：路径类产出的 `abs` 用的是它本身；
   *               `externalUrl` 的 `abs` 是 `new URL(raw).href`，理由见该分支的注释）
   *   `project`—— `{file, name}`（`state.project`）；相对路径类缺它 ⇒ reject `no-project`
   *   `force`  —— `'system'` 表示调用方**明确要交系统打开**（预览头那颗按钮）：只把 `preview` 改判成
   *               `system`，**永远压不过 reject**（不是一条"更松"的口子）
   * @returns {{ok:boolean, abs:string|null, reason:string, action:string, code:string, kind:string}}
   *   `ok:false` ⇒ `abs:null`、`action:'reject'`、`reason` **非空**；调用方**必须**把 `reason` 显示出来。
   */
  function decide(input) {
    const inp = (input && typeof input === 'object') ? input : {};
    const kind = inp.kind;
    const raw = inp.raw;

    function fail(code) {
      return { ok: false, abs: null, reason: REASONS[code], action: 'reject', code: code, kind: kind };
    }

    function pass(abs, action) {
      const forced = (inp.force === 'system' && action === 'preview') ? 'system' : action;
      return { ok: true, abs: abs, reason: '', action: forced, code: '', kind: kind };
    }

    if (KINDS.indexOf(kind) < 0) return fail('path-unknown-kind');
    if (!isString(raw)) return fail('path-not-string');
    if (!raw.trim()) return fail('path-empty');
    if (hasControlChar(raw)) return fail('path-control-char');
    if (isUncOrDevice(raw)) return fail('path-unc-device');     // 判据 2：只按形状拒，绝不探存在性

    /* ---- `externalUrl` 那一档（本批新增）：URL 协议的唯一判据 ----
     * 安全面照 Electron 安全清单：`shell.openExternal` **不许**对不可信内容用
     * ⇒ 一切放行决定都在这里，出口（`app:open-file`）只负责照做，**不再判第二遍**。
     * 顺序有讲究：① 先 `new URL()` 解析（解析不了的就不该交出去）
     *              ② 再协议白名单（`file:` / `javascript:` / `data:` / `vbscript:` / `blob:` / `aimm:` 全落在这一条）
     *              ③ 再凭据（`http://user:pass@…`：交给浏览器会把密码带进历史/地址栏）。 */
    if (kind === 'externalUrl') {
      let u;
      try { u = new URL(raw); }
      catch (err) { return fail('path-url-malformed'); }
      if (ALLOWED_URL_PROTOCOLS.indexOf(u.protocol) < 0) return fail('path-url-scheme');
      if (u.username || u.password) return fail('path-url-credentials');
      /* ⚠️ 交出去的 `abs` 是 `u.href`（**规范化后**的那一份），不是原始串：
       *   这样"判的那一份"和"交出去的那一份"是同一个解析器的同一个产物，中间没有
       *   "判 A 却开 B"的空档。代价（如实记）：`href` 会把中文域名转 punycode、
       *   百分号编码路径、补默认路径 `/`、丢首尾空白 —— 都是浏览器自己也会做的事。 */
      return pass(u.href, 'external');
    }

    const project = inp.project;
    const projectFile = project && project.file;

    if (RELATIVE_KINDS.indexOf(kind) >= 0) {
      if (!isString(projectFile) || !projectFile.trim()) return fail('path-no-project');
      if (isAbsoluteLike(raw)) return fail('path-not-relative');
      const dir = projectDirOf(projectFile);
      // ↓ 与改动前的 `base + '/' + rel` **逐字相同**（混合分隔符 Node 与 Chromium 都吃）
      const abs = dir + '/' + raw;
      const nAbs = normalizeForJudge(abs).toLowerCase();
      const nDir = normalizeForJudge(dir).toLowerCase();
      if (nAbs === nDir) return fail('path-self');                    // 判据 1 的边界：解析结果 = 项目目录本身
      if (nAbs.indexOf(nDir + '\\') !== 0) return fail('path-escape'); // 判据 1：逃出项目目录
      return pass(abs, actionFor(kind, raw));
    }

    // 绝对路径类（localPath / system）：**只校验形状**（判据 4）—— 工作区外是它的正常形态
    if (ABSOLUTE_KINDS.indexOf(kind) < 0) return fail('path-unknown-kind');
    if (!isDriveAbsolute(raw)) return fail('path-not-absolute');
    if (kind === 'localPath' && raw.length > LOCAL_PATH_MAX) return fail('path-too-long');
    return pass(raw, 'system');
  }

  /* ---------------- 第 ③ 段的动作（本批新增，见上面 `OPEN_MODES` 那张表） ----------------
   * 这里是**纯函数**：不碰盘、不起进程、不读时钟 ⇒ 单测里直接把 argv 与"用哪个执行器"钉死。
   * 真正的 I/O 全在 `main.js` 的 `execOpenPlan`（它按 `via` 去调 Electron / 起子进程）。
   * 这样切分的理由（本工程的教训）：**"判据/动作选择"与"动作执行"混在一处时，
   * 断言的只能是"没抛错"**；分开之后，"打开方式到底起没起 OpenAs 对话框"这件事
   * 可以在没有 GUI、不抢焦点的前提下被机械判定。
   */

  /** Windows「打开方式」选择栏的命令（**唯一一处**构造它）。
   *  依据：那一栏是 shell32 的 `OpenAs_RunDLL` 拉起来的，标准命令行形态就是
   *  `rundll32.exe shell32.dll,OpenAs_RunDLL "<绝对路径>"`；Electron **没有**暴露等价 API
   *  （`shell.openPath` 固定用 `open` 动词 ⇒ 有默认关联就直接开，压根不弹选择栏）。
   *  ⚠️ 返回的是 **argv 数组**，调用方必须 `spawn(file, args)` —— **不拼命令行字符串**
   *    （与 `main.js` 的 `launchDetached` 同一条纪律：注入面为 0，含空格/中文的路径不会被引号吃掉）。
   * @param {string} target 已经由 `decide()` 放行过的绝对路径
   * @returns {{file:string, args:string[]}} */
  function openAsCommand(target) {
    return { file: 'rundll32.exe', args: ['shell32.dll,OpenAs_RunDLL', String(target)] };
  }

  /**
   * 打开动作 → **用哪个执行器**（`OPEN_MODES` 那张表的唯一实现）。
   *
   * @param {string} mode   `OPEN_MODES` 之一；`undefined` / `null` / `''` 按 `'default'`（= 既有行为）
   * @param {string} target 已由 `decide()` 放行的绝对路径
   * @param {boolean|null} isDir **打开那一刻** `statSync` 的结论（`null` = 没探 / 探不到）。
   *   ⚠️ 它**只在这里用一次**，绝不写进数据（`docs/DATA-FORMAT.md` §2.1：`localPath` 不校验存在性；
   *      真把它写进数据就等于"点过才知道类型"变成了"数据里多一个会过期的字段"）。
   * @returns {{ok:true, mode:string, target:string, isDir:boolean|null, via:string,
   *            openPath:boolean, showItemInFolder:boolean, spawn:{file:string,args:string[]}|null}
   *          |{ok:false, code:string, reason:string}}
   *   `via` ∈ `['editor'|'openPath'|'openAs'|'reveal']`（执行器名，见 `main.js` 的 `execOpenPlan`）。
   */
  function openPlan(mode, target, isDir) {
    const m = (mode === undefined || mode === null || mode === '') ? 'default' : String(mode);
    if (OPEN_MODES.indexOf(m) < 0) {
      return { ok: false, code: 'open-bad-mode',
        reason: '未知的打开方式（mode 不在 src/path-chain.js 的 OPEN_MODES 内）：' + m };
    }
    if (!isString(target) || !target.trim()) {
      return { ok: false, code: 'open-no-target', reason: '打开目标为空（拿不到要打开的路径）' };
    }
    const dir = (isDir === true) ? true : ((isDir === false) ? false : null);
    const plan = {
      ok: true, mode: m, target: target, isDir: dir, via: 'editor',
      openPath: false, showItemInFolder: false, spawn: null
    };
    if (m === 'default') return plan;                                  // 既有行为（编辑器档）
    if (m === 'system') {                                              // 系统默认程序（目录 = 文件管理器）
      plan.via = 'openPath'; plan.openPath = true; return plan;
    }
    if (m === 'openAs') {                                              // 系统「打开方式」选择栏
      plan.via = 'openAs'; plan.spawn = openAsCommand(target); return plan;
    }
    /* reveal：「在文件资源管理器里打开」——
     *   文件 ⇒ `showItemInFolder`（**在资源管理器里选中它**，不是"打开它"）；
     *   目录 ⇒ `openPath`（打开那个目录本身；对目录 `showItemInFolder` 只会跳到**它的父目录**
     *         并选中它，那不是"打开这个目录"）。
     * `isDir === null`（没探到类型）⇒ 按**文件**处理：执行前 `main.js` 已经因为 stat 失败而
     * 响亮报"文件不在了"，走不到这里；万一走到，"定位一个文件"也比"打开它"更接近用户点的那一项。 */
    if (dir === true) { plan.via = 'openPath'; plan.openPath = true; return plan; }
    plan.via = 'reveal'; plan.showItemInFolder = true; return plan;
  }

  return {
    // 契约面
    decide: decide,
    KINDS: KINDS, ACTIONS: ACTIONS, PREVIEW_EXTS: PREVIEW_EXTS, RELATIVE_KINDS: RELATIVE_KINDS,
    ABSOLUTE_KINDS: ABSOLUTE_KINDS, LOCAL_PATH_MAX: LOCAL_PATH_MAX,
    // 出口动作面（本批）：取值表 + 纯函数（I/O 在 main.js 的 execOpenPlan）
    OPEN_MODES: OPEN_MODES, openPlan: openPlan, openAsCommand: openAsCommand,
    // 出口面（**"哪几档能到出口"只有这一份表**；`main.js` 收 `opts.kind` 时用它过滤）
    EXIT_KINDS: EXIT_KINDS, ALLOWED_URL_PROTOCOLS: ALLOWED_URL_PROTOCOLS,
    // 文案与纯函数（读数脚本与单测直接用；**调用方显示 reason，不许自拼报文**）
    REASONS: REASONS,
    projectDirOf: projectDirOf, extOf: extOf, normalizeForJudge: normalizeForJudge,
    rendererUrlOf: rendererUrlOf,
    isUncOrDevice: isUncOrDevice, hasControlChar: hasControlChar,
    isDriveAbsolute: isDriveAbsolute, isAbsoluteLike: isAbsoluteLike
  };
});
