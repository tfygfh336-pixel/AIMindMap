/* ============================================================
 * src/data-store.js — 项目数据存取（UMD）
 * ------------------------------------------------------------
 * 纯 Node 侧（CLI 用）。渲染层经主进程 IPC 走 CLI，不直接 require。
 * 职责：
 *   - 解析项目名 → projects/<name>/<name>.json 绝对路径
 *   - 读 / 写项目 JSON（写前过 schema.validateProject）
 *   - 全部写盘走原子写（临时文件 + fsync + rename，见 writeFileAtomic）
 *   - **写前**：项目 JSON 有**声明出来的上限**（MAX_PROJECT_FILE_MB），超限**响亮失败且不写盘**
 *   - **写后**：**回读核对**（字节长度 + 能否 parse），不一致**响亮失败**（见 verifyOnDisk）
 *   - **盘上状态三档**（absent / unreadable / ok）：读不回来的文件**不许**被当成"不存在"（见 inspectOnDisk）
 *   - 落盘前的校验走 `store.validatePayload()`（**进程内、不落盘**；GUI 保存闸门的入口）
 *   - 解析时剥离 UTF-8 BOM
 *   - 列出全部项目
 *   - assets/ 与 attachments/ 目录管理（确保存在）
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('fs'), require('path'), require('crypto'), require('./concurrency.js'), require('./changes.js'), require('./heat.js'));
  else root.MMDataStore = factory(null, null, null, null, null, null);
})(typeof self !== 'undefined' ? self : this, function (fs, path, crypto, concurrency, changes, heat) {
  'use strict';

  /**
   * 版本冲突的**错误码**（单源在 `src/concurrency.js`）。
   * 调用方（`src/concurrency.js` 的重放器）**只认这个码，不认错误文本** ——
   * 靠正则匹配报错文本会随文案漂移而**静默失效**（实测踩过：同一天里"守卫被改写作形式静默关掉"两次）。
   */
  const VERSION_CONFLICT = (concurrency && concurrency.VERSION_CONFLICT) || 'VERSION_CONFLICT';

  /**
   * 访问日志的**目录名**：`<项目根>/.visits/<项目名>.jsonl` —— 在项目目录**之外**
   * （理由三条逐字写在 `visitLogFile` 的注释里：项目目录内的零字节不变量 / 痕迹不是内容 / 仍按项目分）。
   * ⚠️ 带前导点 ⇒ 与本工程既有的点文件同一约定（不进列举、不进导出、不进 G6/G8 的数字扫描）。
   */
  const VISIT_DIR_NAME = '.visits';

  /**
   * 项目 JSON 的**声明上限（MB）** —— "写之前就知道太大"那道闸的判据。
   *
   * 为什么必须有（缺陷是**实测**的，不是推测）：`fs.readFileSync(p,'utf8')` 要把整份文件变成一个
   * 字符串，而 V8 的单字符串长度上限是 `0x1fffffe8` 字符 ⇒ 文件大到某个尺寸之后**根本读不回来**。
   * 测量批（`9725bd51`）的二分读数：**500 MB 读得回来 / 540 MB 抛**
   * `Cannot create a string longer than 0x1fffffe8 characters`
   * （`.review/20261034-规模化阈值/logs/06-bigfile-guard.json`）⇒ 物理天花板 ≈ **512 MB**。
   *
   * 为什么是 128（≈ 512 的 1/4）而不是贴着 512：
   *   · 贴着的上限等于"再用一点点就掉下悬崖"。越过物理天花板之后，`store.write` 的"读旧内容"
   *     会失败、版本闸门看不见盘上那份文件，实测后果是 **540 MB 的笔记被静默覆盖成 215 字节**
   *     （同上一份读数；变更日志还记着 `created:true`）。留 4× 余量，让"接近上限"变成一次
   *     **可读的拒绝**，而不是一次**不可逆的销毁**。
   *   · 第二条独立理由（同一批实测）：读一份项目 JSON 的峰值 RSS ≈ 文件大小 × **10.4**
   *     （142.7 MB 文件 ⇒ 1,478 MB 峰值）。文件到 512 MB 时峰值 ≈ 5 GB —— 机器会先 swap/OOM，
   *     根本轮不到"字符串上限"那一步。128 MB 时峰值 ≈ 1.3 GB，仍在可解释的范围内。
   *   · 与本工程真实数据的关系（2026-10-22 现测）：`projects/` 下最大的项目 1.24 MB
   *     ⇒ 上限是它的 **100 倍**，正常使用碰不到；碰到的人需要的是"拆分建议"，不是"更大的上限"。
   *
   * ⚠️ 改这个数就是**抬高判定门槛**，必须同批改 `scripts/collateral-check.js` 的
   *    `CAPPED_LITERALS`（`kind:'pin'`，id `project-file-cap`）并写明为什么 ——
   *    那个门禁会把这次改动变成一次**看得见**的动作（它只认数字字面量，见它的 `pin` 档）。
   */
  const MAX_PROJECT_FILE_MB = 128;

  /** 1 MB 的字节数（**唯一一处**：上限换算与报文里的"≈ N MB"都从这里取，别各写一个 1024*1024）。 */
  const MB_BYTES = 1024 * 1024;

  /**
   * 三条**写路径**错误码（与 `VERSION_CONFLICT` 同一约定：调用方只认 `err.code`，不解析文案）。
   *   · `WRITE_TOO_LARGE`     —— 写前上限核对不通过（**一个字节都没写**）
   *   · `WRITE_VERIFY_FAILED` —— 写后回读核对不通过（字节/parse 与刚写的那份不一致）
   *   · `TARGET_UNREADABLE`   —— 盘上目标文件**存在但读不回来** ⇒ 无条件拒绝覆盖
   */
  const WRITE_TOO_LARGE = 'WRITE_TOO_LARGE';
  const WRITE_VERIFY_FAILED = 'WRITE_VERIFY_FAILED';
  const TARGET_UNREADABLE = 'TARGET_UNREADABLE';

  /** 造一个带错误码的 Error（**唯一一处**：别处直接 `new Error` + 事后赋值会漏掉码）。 */
  function codedError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  /** 把异常压成**一行**可读文本（报文里只留第一行：栈会淹掉判据）。 */
  function shortErr(err) {
    return String((err && err.message) || err).split('\n')[0];
  }

  /** 解析项目 JSON：剥离 UTF-8 BOM（带 BOM 的文本 JSON.parse 会直接失败） */
  function parseProjectJson(text) {
    return JSON.parse(String(text).replace(/^\uFEFF/, ''));
  }

  /**
   * 内容指纹（SHA-1 前 16 位）—— 版本闸门用的「这一版是哪一版」。
   *
   * **为什么不用 mtime / size**：mtime 粒度粗（同秒内的两次写常常拿到同一个 mtime），
   * size 遇到"原地改一个字段"也完全不变 —— 两者都会让闸门**静默失效**（假阴性）。
   * 内容哈希没有这两类漏洞，代价是一次额外的读+哈希（项目 JSON 百 KB 级，1 ms 量级）。
   */
  function versionOfText(text) {
    if (!crypto) return 'n' + String(text).length; // 浏览器端兜底（data-store 非 Node 会直接抛，实际到不了）
    return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 16);
  }

  /** 项目文件的版本指纹；文件不存在 → null（新建项目时闸门据此放行） */
  function versionOf(file) {
    try { return versionOfText(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  }

  /**
   * 盘上那一份的**状态** —— 三档，少一档就会把"读不回来"说成"不存在"（实测踩过，见 `versionGate`）。
   *
   * 为什么不能再用 `versionOf()`（它只回 `string|null`）：那个 `null` 把**两件完全不同的事**
   * 挤成同一个值 —— ① 文件真的不在了；② 文件在、但**读不回来**（超过 `readFileSync` 的字符串
   * 上限 / 权限 / 另一个进程正拿着它）。第 ② 种盘上明明躺着数据，闸门却据此报「盘上 已不存在」，
   * 而实测现场正是一份 540 MB 的项目文件。
   *
   * @param {string} file 绝对路径
   * @returns {{state:'absent'|'unreadable'|'ok', text:(string|null), version:(string|null),
   *            bytes:(number|null), reason:(string|null)}}
   *   `bytes` = `stat` 看到的大小（unreadable 时也尽量给：报文要用它说"到底有多大"）
   */
  function inspectOnDisk(file) {
    // 读两遍的必要性：`stat` 与 `readFileSync` 之间文件可能被别的写入者改掉（本工程的常态是
    // **多路同时写**）⇒ 一次不一致不代表坏，稳定两次才是它此刻的样子。
    for (let attempt = 0; attempt < 2; attempt++) {
      let st;
      try {
        st = fs.statSync(file);
      } catch (err) {
        const code = err && err.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return { state: 'absent', text: null, version: null, bytes: null, reason: null };
        }
        // 存在性都判不了（EPERM / EBUSY / EIO …）⇒ 按"存在但读不回来"处理：**不许**当不存在
        return { state: 'unreadable', text: null, version: null, bytes: null, reason: shortErr(err) };
      }
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (err) {
        return { state: 'unreadable', text: null, version: null, bytes: st.size, reason: shortErr(err) };
      }
      // 读回来了，但**字节数与 stat 对不上** ⇒ 解出来的字符串不是盘上那份字节
      // （UTF-8 非法字节会被换成 U+FFFD，长度随之改变）⇒ 它的"版本指纹"不可信，仍算 unreadable。
      const size = Buffer.byteLength(text, 'utf8');
      let after = null;
      try { after = fs.statSync(file); } catch (e) { after = null; }
      if (after && after.size === st.size) {
        if (size === st.size) {
          return { state: 'ok', text: text, version: versionOfText(text), bytes: st.size, reason: null };
        }
        return { state: 'unreadable', text: null, version: null, bytes: st.size,
          reason: '大小不符（stat 说 ' + st.size + ' 字节，按 UTF-8 解出 ' + size + ' 字节 —— 字节流不构成合法 UTF-8）' };
      }
      // stat 前后不一致 = 读的过程中被改了 ⇒ 再试一次；仍不一致则如实报"读不稳"
    }
    return { state: 'unreadable', text: null, version: null, bytes: null,
      reason: '读的过程中文件一直在变（stat 前后不一致）' };
  }

  /**
   * 把 `inspectOnDisk()` 的读数译成报文里那截括号（**唯一一处**：三种报错共用同一句话，
   * 免得"大小"与"原因"在两处各写一套格式）。
   * 形状 = `（大小 <N> 字节 ≈ <X> MB / 原因：<...>）`；采不到的那一截**明说采不到**，不省略。
   */
  function describeOnDisk(info) {
    const i = info || {};
    const parts = [];
    if (typeof i.bytes === 'number' && isFinite(i.bytes)) {
      parts.push('大小 ' + i.bytes + ' 字节'
        + (i.bytes >= MB_BYTES ? ' ≈ ' + (i.bytes / MB_BYTES).toFixed(1) + ' MB' : ''));
    } else {
      parts.push('大小采不到');
    }
    if (i.reason) parts.push('原因：' + i.reason);
    return '（' + parts.join(' / ') + '）';
  }

  /**
   * **并发版本闸门的唯一比较与报错实现**（`store.write` 与 `writeManagedText` 共用这一份）。
   *
   * 为什么必须是"一个函数"而不是各处各写一段 `if (actual !== expect) throw …`：
   * 项目数据的写入与**整文件受管文档**的写入是两条写路径（后者没有"项目"这个载体，
   * `store.write` 到不了 `CHANGELOG.md` / `docs/**`），但"盘上还是不是我读到的那一版"
   * 是**同一件事**。`architecture-for-ai` A1/D2 明写：只共用底层原语（原子写、哈希函数）
   * 而各自重写比较逻辑**不算共用** ⇒ 比较与报错只此一处，新写路径只许**调它**。
   *
   * 指纹口径 = **整文件内容哈希**（见 `versionOfText` 的注释：不用 mtime/size，两者都会让闸门静默失效）。
   * ⇒ 它对"整文件覆盖写"（本函数另一半用例）与"整树 JSON 写回"用的是同一把尺子。
   *
   * @param {{label:string, hint:string,
   *          expectVersion:(string|null|undefined), actualVersion:(string|null),
   *          actualState:('absent'|'unreadable'|'ok'|undefined),
   *          actualBytes:(number|undefined), actualReason:(string|undefined)}} o
   *   `label` = 报错里"谁被改了"（例：`项目「comnet」` / `受管文件「CHANGELOG.md」`）；
   *   `hint`  = 报错里的出路，**必须是被报的那一方真的做得到的那一句**（F1：死指针不算出路）；
   *   `actualState` / `actualBytes` / `actualReason` = `inspectOnDisk()` 的读数。
   *   ⚠️ **三档必须一起传**：只传 `actualVersion` 会把"存在但读不回来"压成"不存在"（见下）。
   * @throws {Error} `code === 'TARGET_UNREADABLE'`（盘上文件存在但读不回来 ⇒ **无条件**拒绝）
   * @throws {Error} `code === 'VERSION_CONFLICT'`，并带**完整**指纹
   *   `expectVersion` / `actualVersion` / `label`（报文里为可读只印前 8 位，完整值在错误对象上）
   */
  function versionGate(o) {
    const g = o || {};
    /* 「盘上那份到底是什么状态」——**三档**。
     * 没传 `actualState` 的调用形态（老的直接调用）按老口径推断：`actualVersion` 为 null ⇒ absent。 */
    const state = g.actualState
      || (g.actualVersion === null || g.actualVersion === undefined ? 'absent' : 'ok');

    /* ⚠️ **盘上文件存在但读不回来 ⇒ 无条件拒绝**，与调用方有没有声明 `expectVersion` 无关。
     * 这是本批最要紧的一处，理由是**实测**而不是推论：老的 `versionOf()` 读失败就回 `null`，
     * 于是"没声明版本"的写认为盘上没有东西 ⇒ 直接整份覆盖 —— 540 MB 的笔记就是这样被换成
     * 215 字节、而变更日志记着 `created:true`（`.review/20261034-规模化阈值/logs/06-bigfile-guard.json`）。
     * 口径：**读不回来 = 我们不知道盘上有什么** ⇒ 任何覆盖都可能是在销毁别人的数据。
     * 它同时是报文订正的那一半：老文案在这里会说「盘上 已不存在」，而文件明明在。 */
    if (state === 'unreadable') {
      const err = codedError(TARGET_UNREADABLE,
        '盘上文件存在但无法读取' + describeOnDisk({ bytes: g.actualBytes, reason: g.actualReason })
        + '：' + g.label + ' 的那份文件在盘上，但读不回来 ⇒ 写入已中止（**一个字节都没动**）——'
        + '读不回来就不知道盘上有什么，覆盖它可能是在销毁别人的数据。'
        + '出路：先查明它为什么读不回来（项目文件大到超过 readFileSync 的字符串上限 / 权限 /'
        + ' 另一个进程正拿着它），把它挪走或修好之后再写；' + g.hint + '。');
      err.actualState = state;
      err.actualBytes = g.actualBytes;
      err.actualReason = g.actualReason;
      err.label = g.label;
      throw err;
    }

    // 调用方没声明"我读到的是哪一版" ⇒ 不设闸门（行为与从前完全一致；新建文件也是这一档）
    if (g.expectVersion === undefined || g.expectVersion === null) return;
    if (g.actualVersion === g.expectVersion) return;
    const err = new Error('并发写入冲突：' + g.label + '在你读取之后已被其他写入者修改'
      + '（读到 ' + String(g.expectVersion).slice(0, 8) + '，盘上 '
      + (state === 'absent' ? '已不存在' : String(g.actualVersion).slice(0, 8)) + '）。'
      + '写入已中止，以免静默覆盖那次改动 —— ' + g.hint + '。');
    // 错误码：`src/concurrency.js` 的自动重放据此判断"这是可重放的版本冲突"。
    // 有码之后，调用方不必去解析上面这段文案（文案会改）。
    err.code = VERSION_CONFLICT;
    err.expectVersion = g.expectVersion;
    err.actualVersion = g.actualVersion;
    err.label = g.label;
    throw err;
  }

  /**
   * **回读核对**：把"刚写下去的那份内容"从盘上读回来，逐字节比一遍，并要求它能 parse。
   *
   * 为什么必须有这一条（它是本批的**核心防线**，不是附加项）：
   *   "写前声明上限"只挡得住**写之前就知道太大**的那一类。挡不住"写到一半出事" ——
   *   磁盘满 / 进程被杀 / 只写了半截 / 文件系统或杀毒软件把字节改了，
   *   而这些情形下 `fs.writeFileSync` **不一定会抛错**。少了回读，结局就是
   *   "已知的静默销毁"换成"未知的静默销毁"。
   *
   * 判据两条，都必须是**盘上那份字节**算出来的，不是内存里那份算出来的：
   *   ① **字节长度与内容**：`readFileSync` 回来的 Buffer 与期望的 Buffer **逐字节相等**
   *      （只比长度不够：同长度的坏字节照样是坏数据）；
   *   ② **能不能 parse**（`opts.parse !== false` 时）：按项目 JSON 的口径解一遍。
   *
   * 失败 ⇒ 抛 `WRITE_VERIFY_FAILED`，**且不清理任何东西**。
   *   `opts.stage === 'tmp'`    = 换名**之前**核对 ⇒ 目标文件还没被替换，盘上仍是上一版（最好的结局）；
   *   `opts.stage === 'target'` = 换名**之后**核对 ⇒ 盘上可能已经是坏的那份，此时**不许删**
   *   `.changes.jsonl` / `backups/` 之类回滚材料（它们是把数据找回来的唯一线索）。
   *
   * @param {string} file 绝对路径
   * @param {string|Buffer} expected 刚写下去的内容
   * @param {{label?:string, parse?:boolean, stage?:('tmp'|'target')}} [opts]
   * @returns {{bytes:number}} 回读到的字节数（= 期望的字节数）
   * @throws {Error} `code === 'WRITE_VERIFY_FAILED'`
   */
  function verifyOnDisk(file, expected, opts) {
    const o = opts || {};
    const label = o.label || ('文件「' + file + '」');
    const exp = Buffer.isBuffer(expected) ? expected : Buffer.from(String(expected), 'utf8');
    const stage = o.stage === 'target' ? 'target' : 'tmp';
    const tail = stage === 'target'
      ? '⚠️ 目标文件**可能已经被换成了坏的那一份**：产出的结果是"写成功"但内容不可信。'
        + '请立刻核对/恢复 —— **不要删** 该项目的 `.changes.jsonl` 与 `backups/`（它们是回滚材料），'
        + '也不要删同目录下任何 `.tmp` 残留（那是本次写下去的原始字节）。'
      : '目标文件**未被替换**（原子写的临时文件已在核对失败后清理）⇒ 盘上仍是上一次写成功的那一版，'
        + '本次写入没有生效。';

    let got;
    try {
      got = fs.readFileSync(file);
    } catch (err) {
      throw codedError(WRITE_VERIFY_FAILED,
        '写后核对失败：' + label + ' 刚写下去就**读不回来**（' + shortErr(err) + '）——'
        + '盘上那份内容的完整性无法确认。' + tail);
    }
    if (got.length !== exp.length) {
      throw codedError(WRITE_VERIFY_FAILED,
        '写后核对失败：' + label + ' 刚写下去的字节数是 ' + exp.length + '，回读到的却是 ' + got.length
        + '（**大小不符**，差 ' + Math.abs(exp.length - got.length) + ' 字节）—— 这份写入不完整。' + tail);
    }
    if (Buffer.compare(got, exp) !== 0) {
      let at = 0;
      while (at < exp.length && got[at] === exp[at]) at += 1;
      throw codedError(WRITE_VERIFY_FAILED,
        '写后核对失败：' + label + ' 回读到的字节与刚写下去的那份**不一致**'
        + '（大小都是 ' + exp.length + ' 字节，但第 ' + (at + 1) + ' 字节起就不同：'
        + '期望 0x' + exp[at].toString(16) + '，盘上 0x' + got[at].toString(16) + '）—— 写入内容被改过。' + tail);
    }
    if (o.parse !== false) {
      try {
        parseProjectJson(got.toString('utf8'));
      } catch (err) {
        throw codedError(WRITE_VERIFY_FAILED,
          '写后核对失败：' + label + ' 回读到的字节数对得上（' + got.length + ' 字节），但**解析失败**'
          + '（' + shortErr(err) + '）—— 盘上那份不是合法的项目 JSON。' + tail);
      }
    }
    return { bytes: got.length };
  }

  /**
   * 原子写文件：同目录临时文件 → fsync 落盘 → rename 覆盖。
   * 同目录 rename 在 NTFS / POSIX 上均为原子操作，因此进程中断或磁盘写满
   * 只会留下临时文件，**不会产生被截断的目标文件**（防整库损坏）。
   * 失败时清理临时文件并抛出（原文件保持不动）。
   *
   * ⚠️ **rename 的原子性只保证"要么旧的、要么新的"，不保证"新的那份内容是好的"**：
   * `fs.writeFileSync` 在磁盘写满/被杀/只写半截时**不一定会抛**，那样 rename 就会把一份
   * 半截文件堂而皇之地换上目标位。⇒ 传 `opts.verify` 时，**换名之前**先回读核对临时文件
   * （见 `verifyOnDisk` 的注释），核对不过就**不换名**、清理临时文件、抛错 ⇒
   * 目标文件连一瞬都没被动过。这是"写到一半出事"那一类风险的唯一防线。
   *
   * @param {string} file 目标绝对路径
   * @param {string|Buffer} content 完整内容
   * @param {{verify?:({label?:string, parse?:boolean}|boolean)}} [opts]
   *   `opts.verify` 给了就做"换名前回读核对"（`true` = 用默认标签）。**默认不做**：
   *   本函数还被 CHANGELOG / 生成物 / 二进制资源用，核对是每个调用方**按需**加的（本批只给
   *   项目 JSON 那条路加上 —— 它是"被静默换成空壳"实测发生的那一条）。
   */
  function writeFileAtomic(file, content, opts) {
    const o = opts || {};
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
    let fd;
    try {
      fd = fs.openSync(tmp, 'w');
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);          // 关键：先落盘，再 rename
      fs.closeSync(fd);
      fd = undefined;
      if (o.verify) {
        const v = o.verify === true ? {} : o.verify;
        verifyOnDisk(tmp, content, { label: v.label, parse: v.parse, stage: 'tmp' });
      }
      renameWithRetry(tmp, file);
    } catch (err) {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
      throw err;
    }
  }

  /**
   * rename 带**有界重试**：Windows 上目标文件被另一个进程短暂打开时，rename 会以
   * `EPERM` / `EBUSY` / `EACCES` 失败 —— 而"多个会话同时写同一个项目"是本工程的**常态**
   * （多路同时编辑那套机制就是为它做的）。
   * `[实测]` 一次真实并发导入里就出现过：`EPERM: operation not permitted, rename '…comnet.json.45304.…tmp' -> '…comnet.json'`，
   * 调用方原样重跑才成功 —— 那本该由这里吸收掉。
   * 只对**瞬时占用类**错误重试；其它错误立刻抛（不掩盖真问题）。重试次数与间隔都很小（约 100ms 上限），
   * 因为争用窗口极短；重试用尽仍失败 ⇒ 抛出**原错误**（文案里带"已重试 N 次"便于诊断）。
   */
  function renameWithRetry(from, to, attempts) {
    const max = attempts || 6;
    let last = null;
    for (let i = 0; i < max; i++) {
      try { fs.renameSync(from, to); return; } catch (err) {
        const code = err && err.code;
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err;
        last = err;
        // 忙等一小会儿（同步 API 场景下不便真睡；10ms 量级的自旋足够让占用方释放句柄）
        const until = Date.now() + 10 * (i + 1);
        while (Date.now() < until) { /* spin */ }
      }
    }
    if (last) last.message = last.message + '（rename 已重试 ' + max + ' 次仍失败）';
    throw last;
  }

  /* ---------------- 整文件受管文本文档（CHANGELOG / docs/** / 生成物） ----------------
   * 为什么需要这一对函数：`store.write` 的入口是**项目名**，它只覆盖 `projects/<项目>/<项目>.json`。
   * 而 `CHANGELOG.md` / `docs/**` / 登记表 / 生成物是**另一类共享可变资产**（D1 的"闸门管的范围不止数据文件"），
   * 它们没有项目载体 ⇒ 到不了 `store.write`。历史结果是这类资产**根本没有写闸门**：
   * `cli/commands/release.js` 当时用一个纯 `fs.writeFileSync` 整份覆写 CHANGELOG.md，
   * 而 `docs/INCIDENTS.md` 的派生禁令第 5 条**明文禁止裸写** ⇒ 实现违反了自家规则。
   *
   * 口径（三条，缺一条就退化成"第二个闸门"）：
   *   ① 写盘仍走 `writeFileAtomic`（唯一原子写出口）；
   *   ② 版本比对与报错仍走 `versionGate`（**同一份比较逻辑**，不在这里重写 ✗）；
   *   ③ 调用方必须**先**用 `readManagedText` 读、**后**用 `writeManagedText` 写 —— 把"我读到的是哪一版"
   *      从读的那一刻带到写的那一刻。⚠️ 若在同一处"读一下拿版本、紧接着写"，闸门恒等放行、
   *      等于**假闸门**（比没有更坏：它看起来在守）。
   */

  /**
   * 读一份受管文本文档，**同时带回它在盘上的版本指纹**（写回时交给闸门）。
   * @param {string} file 绝对路径
   * @param {{optional?:boolean}} [opts] `optional:true` ⇒ 文件读不到时不抛，返回 `text/version` 皆为 null
   *   （给"生成物可能还不存在"那类调用方用；**默认抛** —— 受管文档读不到就是真问题，别静默当空文件 ✗）
   * @returns {{file:string, text:(string|null), version:(string|null)}}
   */
  function readManagedText(file, opts) {
    if (!fs) throw new Error('readManagedText 仅支持 Node 环境（浏览器端请走 CLI/IPC）');
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (opts && opts.optional) return { file: file, text: null, version: null };
      throw e;
    }
    return { file: file, text: text, version: versionOfText(text) };
  }

  /**
   * 写回一份受管文本文档：**原子写 + 与项目数据同一份版本闸门**。
   * @param {{file:string, version:(string|null)}} handle `readManagedText()` 的返回值
   * @param {string} content 要写的完整内容（整份覆写）
   * @param {{label?:string, hint?:string}} [opts] 只影响报错文案（比较逻辑不可配 ✗）
   * @returns {{file:string, version:string}} 刚写下去的那一版的指纹
   * @throws {Error} `code === 'VERSION_CONFLICT'`（盘上已不是 `handle.version` 那一版）
   */
  function writeManagedText(handle, content, opts) {
    if (!fs) throw new Error('writeManagedText 仅支持 Node 环境（浏览器端请走 CLI/IPC）');
    const o = opts || {};
    const h = handle || {};
    const file = h.file;
    if (!file) throw new Error('writeManagedText 需要一个来自 readManagedText() 的句柄（缺 file）');
    // 旧内容**只读一次**：唯一用途是与调用方声明的版本比对（原子写本身不需要它）。
    // 三档状态一起交给闸门 —— 只给 `version` 会把"存在但读不回来"说成"不存在"（见 `inspectOnDisk`）。
    const onDisk = inspectOnDisk(file);
    versionGate({
      label: o.label || ('受管文件「' + file + '」'),
      hint: o.hint || '请重新读取该文件后再改',
      expectVersion: h.version,
      actualVersion: onDisk.version,
      actualState: onDisk.state,
      actualBytes: onDisk.bytes,
      actualReason: onDisk.reason
    });
    writeFileAtomic(file, content);
    return { file: file, version: versionOfText(content) };
  }

  /* ---------------- 「落盘前校验」的**唯一装配**（CLI 与 GUI 共用） ----------------
   * 项目数据"什么算合法"只有一处实现：`src/schema.js` 的 `validateProject`（本模块**刻意不**
   * require schema —— 存取层不依赖校验实现，靠 `createStore` 的第二参注入）。
   * 而"校验没通过时抛什么"曾经有**两份**：CLI 写路径（`cli/core.js` 的 `validateBeforeWrite`）
   * 与 GUI 保存路径（`main.js` 的 `project:save`）—— 后者原本是"把载荷写成
   * `projects/<项目>/<项目>.json.<pid>.<ts>.validate`，再 spawn 一条 `mm-cli validate <探针>`"，
   * 于是既**绕过唯一写盘出口**、又在**用户数据目录**里留探针（崩溃时不删；2026-10-19 已偿）。
   * 现在两条路径共用这一个工厂 ⇒ 判据、入参、错误文案都不可能分叉。
   */

  /**
   * 造一个「落盘前校验」函数：`(data, projectName) => void`，**不通过就抛**（通过时返回 undefined）。
   *
   * @param {{validateProject:function}} schema 校验实现（`src/schema.js`；由调用方传入，不在这里 require）
   * @param {string} projectsRoot 项目根（跨项目悬挂检测要读盘；= CLI 的 `ctx.PROJECTS_DIR`）
   * @returns {(data:object, name:string) => void}
   * @throws {Error} 文案 **`校验失败: <errors>`**（这句话**只在这一个地方拼**）
   *
   * ⚠️ **`projectName` 必须是显式入参**，别指望推断：`mm-cli validate <文件>` 那条命令是从
   *    **文件的父目录名**推断项目名的（`cli/commands/project.js` 的 `selfProject`；动机见
   *    `docs/changelog/v0.16.0.md` —— 界面删掉被引用节点后，**第一次**保存就得被拦下）。
   *    所以 GUI 侧**不能**靠"把探针放进 `projects/<项目>/`"，也**不能**靠"把它挪进 `os.tmpdir()`"
   *    来解决：后者会让 `selfProject` 变 null、退回"纯读盘校验"，**静默改变语义**。
   *    项目名在保存流程里本来就已知（`path.basename(path.dirname(file))`），直接传即可。
   */
  function createProjectValidator(schema, projectsRoot) {
    if (!schema || typeof schema.validateProject !== 'function') {
      throw new Error('createProjectValidator 需要一个含 validateProject() 的 schema（别传 null）');
    }
    return function validateProjectOrThrow(data, name) {
      const v = schema.validateProject(data, projectsRoot, name);
      if (!v.ok) throw new Error('校验失败: ' + v.errors.join('; '));
    };
  }

  /**
   * **写前上限核对**：payload 的字节数超过 `MAX_PROJECT_FILE_MB` ⇒ 抛 `WRITE_TOO_LARGE`。
   *
   * 位置纪律：它必须在**任何写盘动作之前**（本项目里就是 `writeFileAtomic` 之前）调用，
   * 而且必须在**旧内容读取之前**——超限的写连"读旧内容"都不该发生。
   * 报文三件套（缺一条就等于把人丢在半路）：① 当前多大；② 上限多大、依据是什么；③ 出路。
   *
   * @param {string} name 项目名（只用于报文）
   * @param {number} bytes 序列化后的**字节数**（不是字符数：中文一个字 3 字节）
   * @throws {Error} `code === 'WRITE_TOO_LARGE'`
   */
  function assertWithinCap(name, bytes) {
    const cap = MAX_PROJECT_FILE_MB * MB_BYTES;
    if (bytes <= cap) return;
    const mb = (bytes / MB_BYTES).toFixed(1);
    throw codedError(WRITE_TOO_LARGE,
      '写入被拒：项目「' + name + '」这次要写 ' + mb + ' MB（' + bytes + ' 字节），'
      + '超过声明上限 ' + MAX_PROJECT_FILE_MB + ' MB（= ' + cap + ' 字节）⇒ **一个字节都没写，盘上原文件没动**。'
      + '上限的依据（实测）：读一份项目 JSON 要把它整份变成一个字符串，而 Node 的单字符串长度上限是'
      + ' 0x1fffffe8 字符 —— 实测 500 MB 读得回来、540 MB 读不回来；越过那条线之后旧文件会被静默覆盖。'
      + '故上限取它的四分之一。出路：① 把这个项目拆成几个（每个都在上限以内）；'
      + '② 大块内容（PDF / 图片 / 附件）放项目的 attachments 目录，不要塞进节点详情；'
      + '③ 确实需要更大的项目 ⇒ 那是改约定：同批改 src/data-store.js 的 MAX_PROJECT_FILE_MB 与'
      + ' scripts/collateral-check.js 的 CAPPED_LITERALS，并写明为什么（改动会出现在 diff 里）。');
  }

  function createStore(rootDir, validate) {
    if (!fs || !path) throw new Error('data-store 仅支持 Node 环境（浏览器端请走 CLI/IPC）');

    /**
     * 项目目录。**必须同时挡住路径穿越**，不能只挡非法字符：
     * `name` 为 `..` 时 `path.join(rootDir,'..')` 会落到**项目根之外**，
     * 于是 `store.write('..')` 会在工程目录里写出 `...json`（曾实测）。
     * 触达路径：`mm-cli init ..`。故这里额外要求解析结果严格位于 rootDir 内部。
     */
    function projectDir(name) {
      if (typeof name !== 'string' || !name) throw new Error('非法项目名: ' + name);
      if (/[\\/:*?"<>|]/.test(name)) throw new Error('非法项目名: ' + name);
      // 单独挡掉 . 与 ..（path.join 会归一化它们，事后无法从字符串看出）
      if (name === '.' || name === '..') throw new Error('非法项目名: ' + name);
      const base = path.resolve(rootDir);
      const p = path.resolve(base, name);
      if (p.indexOf(base + path.sep) !== 0) throw new Error('非法项目名（越出项目根）: ' + name);
      return p;
    }
    function projectFile(name) {
      return path.join(projectDir(name), name + '.json');
    }
    /** 变更日志的绝对路径（`src/changes.js` 定文件名；**路径只在这里算一次**，别处不再推导） */
    function changeLogFile(name) {
      return path.join(projectDir(name), changes.FILE_NAME);
    }
    /**
     * 访问事件日志的绝对路径（`src/heat.js` 定文件名与格式）—— 与 `changeLogFile` 同一条规矩：
     * **路径只在这里推导一次**，命令层（`cli/commands/heat.js`）不许自己拼路径。
     * 它同样是**旁路产物**：不是数据、不进 `export-json`、可随时删。
     *
     * ## 为什么放在**项目目录之外**（`<项目根>/.visits/<项目名>.jsonl`）—— 三条理由，缺一不可
     *   ① **"读命令在项目目录里零字节"是本工程硬挣来的不变量**（集成断言 `S3 只读查询不生成索引文件`
     *      钉着它：跑完 search/get/read，项目目录清单与项目文件字节都不许变）。而第三件起
     *      `get`/`read`/`search`/`related`/`ask` 会顺手记访问 ⇒ 日志放在项目目录里**必然**破掉它 ✗。
     *   ② 访问日志是**本机使用痕迹，不是项目内容**：它描述"这台机器上的人/AI 怎么用它"，
     *      而不是"这个项目里有什么"。放进项目目录会让人误以为它属于项目（会被拷进备份、
     *      被别的机器当成事实读走）—— 那是把"痕迹"伪装成"内容"。
     *   ③ 出口一样的轻：仍按项目分文件（一个项目一份，不混在一个大文件里），删一个项目就少一份。
     * ⚠️ **只读路径的"零字节"仍然成立**：项目目录**内**一个字节都不写；写的是**平级的** `.visits/`。
     */
    function visitLogFile(name) {
      if (typeof name !== 'string' || !name) throw new Error('非法项目名: ' + name);
      if (/[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') throw new Error('非法项目名: ' + name);
      const dir = path.join(path.resolve(rootDir), VISIT_DIR_NAME);
      // **目录必须在这里确保存在**：写入端是 `fs.appendFileSync`（O(1) 追加，绝不"先读后判"），
      // 它**不会**建父目录 ⇒ 目录缺失就会 ENOENT。放在路径推导处而不是各调用方：
      // 路径的唯一推导处也应当是"让它可写"的唯一处（否则 `visit` / 埋点 / 主进程三处各 mkdir 一次）。
      // 代价 = 每次调用一次 `mkdirSync(recursive)`：目录已存在时是**一次 stat 级系统调用**（实测微秒级），
      // 与"日志追加本身"同量级 ⇒ 对读路径不构成可测的负担。
      fs.mkdirSync(dir, { recursive: true });
      return path.join(dir, name + '.jsonl');
    }

    /**
     * 追加一条变更日志（**唯一实现**：`write` 与主进程的 GUI 保存都调它）。
     *
     * 为什么要暴露出来：GUI 的保存**不走 `store.write`**（它自己跑 `mm-cli validate` 探针 +
     * `writeFileAtomic`，见 `main.js` 的 `project:save`）。若把记账逻辑在那边再写一份，
     * "改了什么"就有了两种定义 ⇒ 必然漂移（A3）。所以实现只有这里一份，两个出口都调它。
     *
     * **改了什么当场算**（用与冲突判定同一套指纹 `changedKeys`），不是谁手写的。
     * 首次落盘 / 需要裁剪窗口时走整份原子写；平时只追加一行（有界窗口见 `changes.MAX_ENTRIES`）。
     *
     * @param {string} name 项目名
     * @param {{oldText:(string|null), data:any, version:string, writer:string,
     *          idem?:(string|{key:string}), out?:string}} opts
     *        `oldText` = **本次写入之前**盘上的内容（null = 盘上原本没有 ⇒ 记为"新建"）
     *        `idem` / `out` = 写命令的**幂等键**与**首次回显**（可选，见 `src/changes.js` 的 `buildEntry`；
     *        调用方是 `cli/core.js` 的幂等守卫，这里只做**转交**，不判定、不解释）
     */
    function recordChange(name, opts) {
      if (!changes) return null;
      const o = opts || {};
      let oldData = null;
      if (o.oldText !== undefined && o.oldText !== null) {
        try { oldData = parseProjectJson(o.oldText); } catch (e) { oldData = null; }
      }
      // ⚠️ `changedKeys` 返回的是 **Set**，必须 `Array.from` —— 直接塞进 JSON 会序列化成 `{}`，
      //    而 `appendLog` 的 `Array.isArray` 检查会把它变成空数组 ⇒ 日志**每次都报"没有对象变化"**。
      //    这是可见性功能最坏的失效形态（告诉会话"没人动过"，而其实动了）。有一条单测锁它。
      const changedSet = (oldData === null || !concurrency) ? null : concurrency.changedKeys(oldData, o.data);
      const changed = changedSet ? Array.from(changedSet) : [];
      // 幂等键：两种形态都收（`{key}` 是核心层传的内部形状，字符串是直给）——
      // 归一放在这里**一处**，免得每个写入方各判一次"给了没给"。
      const idemRaw = o.idem && typeof o.idem === 'object' ? o.idem.key : o.idem;
      const file = changeLogFile(name);
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) { text = ''; }
      const r = changes.appendLog(text, {
        at: new Date().toISOString(),
        writer: o.writer,
        version: o.version,
        created: oldData === null,     // 盘上原本没有 ⇒ 这是"新建"，changed 为空是正常的
        changed: changed,
        idem: idemRaw,
        out: o.out
      }, changes.MAX_ENTRIES);
      if (!text || r.trimmed > 0) writeFileAtomic(file, r.text);   // 首次 / 裁剪窗口 ⇒ 整份原子写
      else fs.appendFileSync(file, changes.serializeEntry(r.entry), 'utf8');
      return r.entry;
    }

    /**
     * **补上一次写入的"首次回显"**（S7 的延迟落账）。
     *
     * 为什么需要"补"而不是"写的时候一起写"：写命令的收尾回执（`已添加: n-xxxx`）发生在
     * `store.write` **返回之后** ⇒ 写盘那一刻还拿不到它（见 `cli/core.js` 的 `markRecord`）。
     * 于是命令体跑完时用它把最后那几行补进**同一条**记录（按 `idem` 键定位），
     * 幂等重放才能复述出"首次那个随机 id"。
     *
     * 定位靠 `idem` 键：只改**最后一条**且键相同的那条（找到就从尾往前改第一条）。
     * 找不到就**什么都不做**（日志被裁剪 / 被删 / 键已被顶掉 ⇒ 宁可少一条回显，也不编造）。
     * @returns {boolean} 是否真的补上了
     */
    function recordChangeOut(name, idemKey, outText) {
      if (!changes || !idemKey) return false;
      const file = changeLogFile(name);
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return false; }
      const parsed = changes.parseLog(text);
      const hit = changes.idemLookup(parsed.entries, idemKey);
      if (!hit) return false;
      // 逐行改写**最后一条**匹配记录（保留原行序、原条数 ⇒ 不破坏"日志是有界追加流"的性质）
      const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        let raw;
        try { raw = JSON.parse(lines[i]); } catch (e) { continue; }
        if (!raw || raw.idem !== idemKey) continue;
        raw.out = String(outText).slice(0, changes.OUT_MAX);
        lines[i] = changes.serializeEntry(changes.buildEntry(raw)).replace(/\n$/, '');
        writeFileAtomic(file, lines.join('\n') + '\n');
        return true;
      }
      return false;
    }

    return {
      rootDir,

      list() {
        if (!fs.existsSync(rootDir)) return [];
        return fs.readdirSync(rootDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && fs.existsSync(path.join(rootDir, e.name, e.name + '.json')))
          .map((e) => {
            const jsonPath = path.join(rootDir, e.name, e.name + '.json');
            try {
              const data = parseProjectJson(fs.readFileSync(jsonPath, 'utf8'));
              return { name: e.name, meta: data.meta || null, file: jsonPath };
            } catch (err) {
              return { name: e.name, meta: null, file: jsonPath };
            }
          });
      },

      read(name) {
        const file = projectFile(name);
        /* 三档判据（**不许**再用 `existsSync` 当"在不在"）：`existsSync` 对"存在但读不回来"
         * 的文件回 true，随后 `readFileSync` 抛的是 Node 原始报文（`Cannot create a string longer
         * than 0x1fffffe8 characters`）—— 读的人只能看到一句与自己无关的实现细节，
         * 看不出"我的笔记文件太大/坏了"。这里把它换成"存在但无法读取（多大 / 为什么）"。 */
        const onDisk = inspectOnDisk(file);
        if (onDisk.state === 'absent') throw new Error('项目不存在: ' + name);
        if (onDisk.state === 'unreadable') {
          throw codedError(TARGET_UNREADABLE, '项目「' + name + '」的文件**存在但无法读取**'
            + describeOnDisk(onDisk) + ' —— 这份数据现在既读不出来、也不该被任何写入覆盖；'
            + '先查明原因（文件过大超过 readFileSync 的字符串上限 / 权限 / 另一个进程正拿着它）。');
        }
        let data;
        try {
          data = parseProjectJson(onDisk.text);
        } catch (err) {
          // "字节读回来了但解析不了"是**另一种**不可用（区别于不存在，也区别于读不回来）
          throw codedError(TARGET_UNREADABLE, '项目「' + name + '」的文件**存在但无法解析**'
            + describeOnDisk({ bytes: onDisk.bytes, reason: '解析失败：' + shortErr(err) })
            + ' —— 这份数据现在既解析不出来、也不该被任何写入覆盖；先查明它是什么时候、被什么写坏的'
            + '（`changes` 命令有逐条写入记录）。');
        }
        // version 一并返回：调用方（CLI 的 ctx / GUI 主进程）用它做写入前的并发闸门
        return { file, data, version: onDisk.version };
      },

      write(name, data, opts) {
        const o = opts || {};
        // 把项目名一并交给校验器：同项目的链接/关联成员要以"即将写下去的这份数据"
        // 为准（见 schema.validateProject 的 selfProject 说明），否则闸门慢一步。
        if (validate) validate(data, name); // 写盘前校验（安全闸门）
        const file = projectFile(name);

        /* ---- 写前 ①：**上限核对**（超限 ⇒ 响亮失败，且一个字节都不写）----
         * 序列化**只此一处**：随后"落盘 / 上限核对 / 回读核对 / 算指纹"用的都是**同一个字符串**。
         * 若各处各 `JSON.stringify` 一次，核对的那份与落盘的那份就可以不同 ⇒ 判据会自证清白。 */
        const json = JSON.stringify(data, null, 2);
        const payloadBytes = Buffer.byteLength(json, 'utf8');
        assertWithinCap(name, payloadBytes);

        // ---- 旧内容**只读一次**（三档状态：absent / unreadable / ok）----
        // 两个用途：① 并发版本闸门要比对它的指纹；② 变更日志要拿它算"改了什么"。
        // ⚠️ 读不回来**不再等于**"盘上没有"—— 那正是 540 MB 笔记被静默换成空壳的成因。
        const onDisk = inspectOnDisk(file);

        // ---- 并发版本闸门 ----
        // 调用方若声明了「我读到的是哪一版」（expectVersion），就要求盘上仍是那一版。
        // 不是 → 说明读与写之间**别处写入过**，此时写下去会把那次改动**静默抹掉**。
        // 实测两条真路径（见 main.js project:save 的注释）：内存里是子集时写回会删掉
        // 其他笔记；AI/CLI 在界面打开期间写的笔记会被界面的整树覆盖。
        // 口径：**宁可失败，也不静默丢数据**。不传 expectVersion 时版本比对不设闸门，
        // 但"盘上文件存在却读不回来"**仍然**拒绝（那一档与 expectVersion 无关）。
        // ⚠️ 比较与报错的实现**只此一份**（`versionGate`）—— `writeManagedText`（整文件受管文档）
        //    走的是同一个函数；这里不许再出现一段 `if (actualVersion !== expectVersion)`。
        versionGate({
          label: '项目「' + name + '」',
          hint: '请重新读取该项目后再改',
          expectVersion: o.expectVersion,
          actualVersion: onDisk.version,
          actualState: onDisk.state,
          actualBytes: onDisk.bytes,
          actualReason: onDisk.reason
        });

        fs.mkdirSync(projectDir(name), { recursive: true });
        /* 原子写 + **换名前回读核对**（`verify: {…}`）：写坏的那一份永远换不进目标位。
         * 只挡住"写之前就知道太大"是不够的 —— 磁盘满 / 被杀 / 只写半截时
         * `fs.writeFileSync` 不一定抛错，那样 rename 会把半截文件换上目标位。 */
        writeFileAtomic(file, json, { verify: { label: '项目「' + name + '」', parse: true } });
        /* ---- 写后 ②：**目标文件回读核对**（换名之后再看一眼盘上那份字节）----
         * 与上一步判据相同（字节 + parse），但对象是**最终可观测的那份产物**；
         * 不一致 ⇒ 抛 `WRITE_VERIFY_FAILED` 并**保留全部回滚材料**（见 verifyOnDisk 的 stage 分支）。 */
        verifyOnDisk(file, json, { label: '项目「' + name + '」', parse: true, stage: 'target' });
        // 一并回传"刚写下去的这一版"的指纹：调用方（ctx.write / 自动重放器）据此更新自己记的版本，
        // 免得同一条命令里紧接着再写一次时**误报**冲突。序列化只有这一处，不重复第二种写法。
        const version = versionOfText(json);
        // ---- 变更日志（阶段 3：让别的会话"事前避让"）----
        // 这是**辅助产物**（不是数据、不进 export-json、可随时删）。它失败**不能让本次写入失败**
        // —— 数据安全优先；但也**绝不静默**：打到 stderr，让调用方看得见（F1）。
        try {
          recordChange(name, {
            oldText: onDisk.text, data: data, version: version, writer: o.writer,
            // 幂等键与首次回显：**只转交**（判定与回放都在 `cli/core.js` 的守卫里）。
            // 不走 `store.write` 的调用方（如 `import-json`）自然拿不到它们 ⇒ 字段缺席，行为与从前一致 ✓
            idem: o.idem, out: o.out
          });
        } catch (err) {
          console.error('warning: 变更日志写入失败（本次数据已写入，日志缺一条）：'
            + ((err && err.message) || err));
        }
        return { file, version: version };
      },

      assetDir(name) {
        const dir = path.join(projectDir(name), 'assets');
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      },

      attachmentDir(name) {
        const dir = path.join(projectDir(name), 'attachments');
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      },

      projectDir,
      projectFile,
      /** 变更日志路径（读方 —— 如 `changes` 命令 —— 用它，别自己拼路径） */
      changeLogFile,
      /** 访问事件日志路径（读方/写方 —— `heat` / `visit` —— 用它，别自己拼路径） */
      visitLogFile,
      /**
       * 访问日志的**目录**（`<项目根>/.visits/`）—— 只为两件事存在：① 从项目目录**搬走**时
       * 能定位旧位置；② 测试/维护脚本要清空全部访问痕迹时有个正规入口（不自己拼路径）。
       * ⚠️ 它**不在**项目目录里，所以不会出现在任何"项目目录清单"判据里（那正是它的目的）。
       */
      visitDir() { return path.join(path.resolve(rootDir), VISIT_DIR_NAME); },
      /** 记一条变更日志（GUI 保存那条不走 `write` 的路径也要调它 —— 实现只有一份） */
      recordChange,
      /** 给**最近那条**带 `idem` 的记录补上"首次回显"（S7 的延迟落账；见该函数注释） */
      recordChangeOut,
      // 供 import-json 解包资源（图片/附件）使用，同样保证原子落盘
      writeFileAtomic
    };
  }

  /* ==========================================================================
   * 「载荷没带就从磁盘取回」—— `project:save` 的**数据安全那一层**（唯一实现）
   * --------------------------------------------------------------------------
   * 为什么必须有（本批实测的缺陷 ②）：GUI 保存的载荷是渲染层手里那份**整棵树的拷贝**，
   * 它只带"渲染层自己拥有的东西"。凡是**只由 AI/CLI 写**的项目级键，渲染层的内存里只是
   * "上次读到的一份拷贝" —— 直接整份写回就会把它们**静默抹掉**（`assoc` 当年正是这么坏的：
   * 实测两条路径 —— 内存里是某节点的子集时写回删掉其它笔记；AI 在界面打开期间写的笔记从未被见过）。
   *
   * 两档规则**不同**，别拍平（拍平必错，两条的理由不一样）：
   *   · `assoc`：**磁盘有非空 assoc 就一律以磁盘为准**（界面从不改它 ⇒ 内存那份永远不该赢）；
   *   · `graph`：**载荷没带这个键才取回**（全模式会写它 ⇒ 载荷带了就必须用载荷的）。
   *
   * 放在本文件而不是 `main.js` 里内联：这里能被 node 直接跑（单测 / 判别力注入都不需要起 Electron），
   * 而 `main.js` 起不来 Electron 就连 require 都失败 ⇒ 判据会退化成"读源码 grep"（那证明不了它真的保护了）。
   * `main.js` 的 `project:save` 只调它，不再自己写第二份规则。
   *
   * @param {object} payload 即将落盘的载荷（渲染层/调用方给的那份；**只读**，不修改入参）
   * @param {object} diskData 盘上现有一份（读不回来时传 null）
   * @returns {object} 取回之后的载荷（可能是原对象；调用方负责序列化）
   */
  function prepareSavePayload(payload, diskData) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
    const disk = (diskData && typeof diskData === 'object' && !Array.isArray(diskData)) ? diskData : null;
    if (!disk) return payload;
    let out = payload;
    // 档一：assoc（磁盘优先 —— 与历史上那条行为**逐字一致**，改动只是把规则搬到一处）
    if (Array.isArray(disk.assoc) && disk.assoc.length) {
      out = Object.assign({}, out, { assoc: disk.assoc });
    }
    // 档二：graph（**载荷没带才取回**）。判据是"这个键在不在"，不是"它等不等于空"
    // —— `graph: {}` 与"没有 graph"在语义上不同（前者是"我明确说这张图没有附加结构"）。
    const hasOwnGraph = Object.prototype.hasOwnProperty.call(payload, 'graph');
    if (!hasOwnGraph && disk.graph !== undefined) {
      out = Object.assign({}, out, { graph: disk.graph });
    }
    return out;
  }

  return {
    createStore, writeFileAtomic, parseProjectJson, versionOf, versionOfText,
    createProjectValidator,
    // 并发版本闸门的**唯一**比较/报错实现 + 整文件受管文档的读写对（`cli/commands/release.js` 用）
    versionGate, readManagedText, writeManagedText,
    // 「载荷没带就从磁盘取回」（GUI 保存的数据安全那一层；唯一实现，见函数头）
    prepareSavePayload,
    // 本批（数据安全）：声明上限 + 盘上状态三档 + 三个错误码。
    // `MAX_PROJECT_FILE_MB` 导出是为了让**判据**读它而不是抄一份（抄一份就是同一事实的第二处表达）。
    MAX_PROJECT_FILE_MB, inspectOnDisk, describeOnDisk, assertWithinCap, verifyOnDisk,
    WRITE_TOO_LARGE, WRITE_VERIFY_FAILED, TARGET_UNREADABLE
  };
});
