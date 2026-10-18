/* ============================================================
 * src/change-log.js — 「AI 改了哪些文件」清单的**唯一实现**（UMD；纯函数 + 一个写盘出口）
 * ------------------------------------------------------------
 * ## 这一模块存在的理由（一句话）
 * 内核 `@deepseek-ai/dsh-workspace-changes` 已经会算"本回合改了哪些文件"，但它**没有 UI**，
 * 而且实测缺两块（取证见 `.review/20261018-改动清单/README.md` 与看板卡 fdbf17d）：
 *   ① **子代理会话一律不录** —— 逐字：`return origin === 'subagent' || (delegationDepth ?? 0) > 0 ? undefined : cwd;`
 *      （`vendor/dsh/.../dsh-workspace-changes/lib/index.js:984-987`）；本机 29 个会话里 16 个是全子代理、changes 全 no；
 *   ② **摘要是 Host 内存态** —— `session/disposed ⇒ forget`（同文件 :1034-1039 的 `byId.delete`），
 *      日志里 13 条历史事件去问运行实例 ⇒ 13/13 `404 Change summary unavailable.`。
 * 本模块补的就是这两条：**不依赖 Host 会话状态 ⇒ 子代理天然覆盖**；**落盘 ⇒ 重启后还在**。
 *
 * ## 为什么数据源是 git working tree（而**不是**另两条）
 * 三条候选不同层，逐条说清为什么不选：
 *   · **① git working-tree 快照 —— 选它**。它读的是**盘上的工作树**，跟"谁写的"无关：
 *     主会话、子代理会话、用户在外部编辑器里改、别的进程写，全都一样看得见 ⇒ **子代理覆盖是结构性的，
 *     不是靠某条分支补的**。而且它**不要求 DSH 在跑**：面板在 Host 停着、重启之后照样能读。
 *     ⚠️ 它也是内核自己用的那条源（`lib/types/git.js` 的 snapshot tree + `diff-tree --numstat`）⇒
 *     两边讲的是**同一个物理事实**，不会出现"同一件事两处说法"。
 *   · **② `dsh-tool-fs` / `dsh-tool-str-replace-editor` 的写入事件 —— 不选**。三层原因：
 *     ㈠ 那些事件活在 **Host 进程**里（`workspaceChanges` 是 `ctx.provide` 的服务），我们的面板在
 *        **Electron 主进程**，要收它得先当 DSH 插件 ⇒ 触到"不 fork 内核 / 不手改 `cordis.patch.yml`"的红线；
 *     ㈡ 它是**会话内的瞬态事件**：Host 不在跑就没有事件，重启就没了 —— 正是我们要补的那一半✗；
 *     ㈢ 它只覆盖"工具写的"，`bash` 重定向、其它进程、用户手动改都漏 ⇒ 覆盖面反而更窄。
 *   · **③ 我们自己的写盘出口（`writeFileAtomic` / `writeManagedText`）—— 不选**。
 *     它只覆盖**我们自己**写的那几类受管资产，对"AI 改了什么"覆盖率接近 0 ⇒ 答不上题目本身。
 *
 * ## 度量口径（**必须与内核那个数分得清**，否则就是"同一事实两处表达"）
 *   · 内核记的是 **turn 起点树 → turn 终点树**（"这一回合改了多少行"）；
 *   · 本模块记的是 **HEAD → 采样那一刻的工作树**（"**累计**还没提交的改动"）。
 * 两者**不是同一个数**（一个文件早先几轮就改过、本轮没动 ⇒ 内核记 0，我们仍记累计行数）。
 * ⇒ 界面**逐字标注口径**（"相对 HEAD 的累计改动"），**绝不冒充**"本回合"。取内核读数做补充的前提
 * 是它能取到 —— 而它取不到的恰好就是本模块存在的两个理由，所以本模块**不依赖**它（详见 README）。
 *
 * ## 单一写者（判据 ②）
 * 这个文件的 `createStore().record()` 是**唯一**把字节写进 `change-log.jsonl` 的地方，
 * 且只经 `src/data-store.js` 的 `writeFileAtomic`（原子写：tmp + fsync + rename）。
 * 结构读数：`grep -rn "change-log.jsonl" --include=*.js .` 只有本文件一处；
 * `fs.writeFileSync` 在本文件里**一次都不出现**（写盘只走注入进来的 `writeFileAtomic`）。
 *
 * ## 只增 ≠ 不设界
 * 记录**只追加、从不改写既有行**；但日志是"观察流水"不是账本 ⇒ 有界窗口 `MAX_RECORDS`。
 * 裁剪时**保住每个文件的最新一条**（`compact`）：否则一个早先改过、之后一直没再动的文件
 * 会因为"它那条老记录被裁掉"而**从清单里凭空消失**（把"还在改"说成"没改" —— 本工程最重的损害类别）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMChangeLog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ============================================================
   * 一、常量（**唯一定义处**：文件名、版本、窗口、采样最小间隔、状态码的人话）
   * ============================================================ */

  /** 落点文件名（**只有这一处**写它；主进程只从 `fileOf()` 的调用方拿路径） */
  const FILE_NAME = 'change-log.jsonl';
  /** 记录版本。字段**只增不改**（同 `src/changes.js` 的先例：可选字段不升版本号） */
  const ENTRY_VERSION = 1;
  /**
   * 有界窗口。取值理由：一屏列表最多看几十行，而"每个文件的最新一条"必须活着；
   * 400 条 ≈ 100KB 量级（一条约 200–260 字节）⇒ 整份原子写的代价仍是毫秒级。
   */
  const MAX_RECORDS = 400;
  /**
   * 两次采样之间的**最小间隔**（同一次面板开关里的重复请求复用同一份快照）。
   * 取值理由：本机实测**一次采样 = 两个 git 子进程 ≈ 0.26 s + 0.28 s**（见 README 的读数），
   * 面板"开→关→开"若每次都真跑一遍，G5 里就会凭空多出几秒；1.5 s 覆盖"手抖连点"，
   * 又不会让"过一会儿再看"拿到过期读数。**显式刷新（按钮）永远绕过它**。
   */
  const SAMPLE_MIN_INTERVAL_MS = 1500;

  /**
   * 状态码表（**唯一定义处**；界面只显示 `statusText`，绝不自己再写一份中文）。
   * `'='` = **已回到 HEAD**（用于"之前改过、这次采样看不到了"的冲销记录）。
   */
  const STATUS_TEXT = {
    M: '已修改',
    A: '新增（已暂存）',
    D: '已删除',
    R: '已改名',
    '?': '未跟踪',
    U: '冲突未解',
    '=': '已回到 HEAD'
  };

  /** 度量来源（人话；界面显示"这个 +N/−M 是怎么数出来的"） */
  const SRC_TEXT = {
    numstat: '行数取自 git diff --numstat',
    'file-lines': '行数取自文件行数（该文件 git 不覆盖）',
    binary: '二进制文件：行数拿不到（不是 0 行）',
    none: '行数拿不到'
  };

  /** 未跟踪文件按行数计数时的读取上限（与内核的 `maxFileBytes` 同量级） */
  const COUNT_MAX_BYTES = 2 * 1024 * 1024;
  /** 二进制嗅探窗口（字节数）—— 与 git 自己的启发式同口径：前 8000 字节里有 NUL 就算二进制 */
  const COUNT_SNIFF_BYTES = 8000;

  /**
   * 三条 git 命令的 **argv 单源**。为什么要把 argv 也放进模块：
   * 判据 ① 要求"每条记录能追溯到数据源" ⇒ 追溯读数必须是**可原样重跑的**那串参数，
   * 而不是一句人话描述。界面把它照着印出来，探针/冒烟照着它再跑一遍对拍 ⇒ 谁都没在猜。
   */
  const GIT_ARGV = {
    repoRoot: ['rev-parse', '--show-toplevel'],
    head: ['rev-parse', 'HEAD'],
    status: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    numstat: ['diff', '--numstat', '-z', '-M', 'HEAD']
  };

  const GIT_ENV = {
    // 只读：不写用户 `.git/index`（`git status` 默认会顺手刷新索引）—— 采样绝不能让仓库变脏
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C'
  };

  /* ============================================================
   * 二、纯函数（零 I/O、零时钟 —— node 单测可直测；判据与判别力证明都在 tests/change-log.test.js）
   * ============================================================ */

  /** 状态码归一：porcelain 的 `XY` 两位 → 一个字母（`??` 折算成 `?`） */
  function normStatus(code) {
    const s = String(code === undefined || code === null ? '' : code);
    if (s === '??' || (s.length >= 2 && s[0] === '?' && s[1] === '?')) return '?';
    // 冲突族（UU / AA / DD / AU / UA / DU / UD）统一记 'U'
    if (s.indexOf('U') >= 0 || s === 'AA' || s === 'DD') return 'U';
    // 改名 / 复制：`R ` 或 ` R` 都算改名（旧路径随记录一起给出）
    if (s.indexOf('R') >= 0 || s.indexOf('C') >= 0) return 'R';
    if (s.indexOf('A') >= 0) return 'A';
    if (s.indexOf('D') >= 0) return 'D';
    if (s.indexOf('M') >= 0) return 'M';
    return s.trim()[0] || 'M';
  }

  /**
   * 解析 `git status --porcelain=v1 -z --untracked-files=all`。
   *
   * 形状是**实测**出来的（`.review/20261018-改动清单/git-shapes.txt`，git 2.55）：
   *   · 普通条目：`XY<空格>path\0`
   *   · **改名条目占两个字段**：`XY<空格>newPath\0oldPath\0`
   * ⚠️ 把改名当普通条目解析 ⇒ 旧路径会被当成"另一个被改的文件"混进清单（凭空多一条）。
   * 坏字段**不静默丢**：进 `bad[]`，随结果一并回报。
   */
  function parseStatusZ(text) {
    const out = { rows: [], bad: [] };
    const s = String(text === undefined || text === null ? '' : text);
    if (!s) return out;
    const fields = s.split('\0');
    // -z 的输出**以 NUL 结尾** ⇒ 最后一个是空串（不是一条记录）
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (f === '') continue;
      if (f.length < 4) { out.bad.push({ index: i, raw: f }); continue; }
      const code = f.slice(0, 2);
      const p = f.slice(3);
      const row = { code: code, path: p, status: normStatus(code) };
      if (row.status === 'R') {
        const from = fields[i + 1];
        if (from === undefined || from === '') { out.bad.push({ index: i, raw: f, why: 'rename 缺旧路径' }); }
        else { row.oldPath = from; i++; }
      }
      out.rows.push(row);
    }
    return out;
  }

  /**
   * 解析 `git diff --numstat -z -M HEAD`。
   *
   * 形状同样实测过：一条记录在**同一个 NUL 字段**里是 `add\tdel\tpath`；
   * **改名**时该字段的 path 为空，后面再跟两段（旧路径、新路径）。二进制是 `-\t-`。
   * ⇒ 只按"前两个 tab"切，文件名里自己的 tab 不动（照内核 `parseNumstat` 的口径）。
   */
  function parseNumstatZ(text) {
    const out = { rows: [], bad: [] };
    const s = String(text === undefined || text === null ? '' : text);
    if (!s) return out;
    const queue = s.split('\0');
    if (queue.length && queue[queue.length - 1] === '') queue.pop();
    while (queue.length) {
      const rec = queue.shift();
      if (rec === '' ) continue;
      const t1 = rec.indexOf('\t');
      const t2 = t1 < 0 ? -1 : rec.indexOf('\t', t1 + 1);
      if (t2 < 0) { out.bad.push({ raw: rec }); continue; }
      const addRaw = rec.slice(0, t1);
      const delRaw = rec.slice(t1 + 1, t2);
      let p = rec.slice(t2 + 1);
      const row = { path: p, binary: addRaw === '-' };
      if (p === '') {
        const oldPath = queue.shift();
        const newPath = queue.shift();
        if (oldPath === undefined || newPath === undefined) { out.bad.push({ raw: rec, why: 'rename 段不完整' }); continue; }
        row.oldPath = oldPath;
        row.path = newPath;
      }
      row.add = row.binary ? null : Number(addRaw);
      row.del = row.binary ? null : Number(delRaw);
      if (row.add !== null && (!isFinite(row.add) || row.add < 0)) { out.bad.push({ raw: rec, why: 'added 非数字' }); continue; }
      if (row.del !== null && (!isFinite(row.del) || row.del < 0)) { out.bad.push({ raw: rec, why: 'deleted 非数字' }); continue; }
      out.rows.push(row);
    }
    return out;
  }

  /**
   * 数一个文本有多少行（末尾换行**不多算一行**）。
   * ⚠️ `''` 与 `'a'` 分别是 0 与 1：拿 `split('\n').length` 直接交差会把空文件说成 1 行。
   */
  function countLines(text) {
    const s = String(text === undefined || text === null ? '' : text);
    if (s === '') return 0;
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
    if (s.charCodeAt(s.length - 1) !== 10) n++;
    return n;
  }

  /**
   * 把两份 git 输出合成"工作树相对 HEAD 的状态"。
   *
   * @param {{statusText:string, numstatText:string, numstatOk:boolean,
   *          lineCounts?:Object, countSkipped?:string[], binaryPaths?:string[], notes?:string[]}} o
   *   `numstatOk === false`（没有 HEAD / git 报错）⇒ **全部走行数回退档**，
   *   并逐条标 `src:'file-lines'` —— "数法变了"必须看得见，不许悄悄换一种口径。
   *   `lineCounts` = `path → 行数`（调用方读盘数好传进来；纯函数不碰 I/O）；
   *   `countSkipped` = 读不了/太大跳过的路径；
   *   `binaryPaths` = **未跟踪的二进制**（git 不覆盖它 ⇒ 不能按文本数行数）。
   *     ⚠️ 这一档是探针实测逼出来的：一个未跟踪的 `bin.dat` 若按 utf8 数行会得到"1 行"，
   *     于是清单里冒出一个**凭空捏造的行数**。二进制一律 `add/del = null + binary:true`。
   * @returns {{rows:Array, bad:Array, notes:string[]}}
   */
  function mergeRows(o) {
    const opt = o || {};
    const notes = Array.isArray(opt.notes) ? opt.notes.slice() : [];
    const status = parseStatusZ(opt.statusText);
    const numstat = opt.numstatOk === false
      ? { rows: [], bad: [] }
      : parseNumstatZ(opt.numstatText);
    const counts = opt.lineCounts || {};
    const skipped = Array.isArray(opt.countSkipped) ? opt.countSkipped : [];
    const binaries = new Set(Array.isArray(opt.binaryPaths) ? opt.binaryPaths : []);
    const bad = status.bad.concat(numstat.bad);

    // 行数表：path → {add, del, binary, src}
    const byPath = new Map();
    numstat.rows.forEach((r) => {
      byPath.set(r.path, { add: r.add, del: r.del, binary: !!r.binary, src: 'numstat' });
    });

    const rows = status.rows.map((sr) => {
      const hit = byPath.get(sr.path);
      if (hit) {
        return {
          path: sr.path, oldPath: sr.oldPath, code: sr.code, status: sr.status,
          add: hit.add, del: hit.del, binary: hit.binary, src: hit.src
        };
      }
      // git 不覆盖这条路径（未跟踪 / 没 HEAD）：行数只能从盘上数
      if (binaries.has(sr.path)) {
        // **二进制：行数是"拿不到"，不是 0**（按 utf8 数出来的那个数纯属捏造）
        return {
          path: sr.path, oldPath: sr.oldPath, code: sr.code, status: sr.status,
          add: null, del: null, binary: true, src: 'binary'
        };
      }
      if (Object.prototype.hasOwnProperty.call(counts, sr.path)) {
        const n = Number(counts[sr.path]);
        return {
          path: sr.path, oldPath: sr.oldPath, code: sr.code, status: sr.status,
          add: sr.status === 'D' ? 0 : (isFinite(n) ? n : null),
          del: sr.status === 'D' ? (isFinite(n) ? n : null) : 0,
          binary: false, src: 'file-lines'
        };
      }
      return {
        path: sr.path, oldPath: sr.oldPath, code: sr.code, status: sr.status,
        add: null, del: null, binary: false,
        src: 'none', skipped: skipped.indexOf(sr.path) >= 0
      };
    });

    // 只出现在 numstat 里、status 里没有的路径（理论上不该有；真有就补上并**记一笔**）
    const inStatus = new Set(status.rows.map((r) => r.path));
    numstat.rows.forEach((r) => {
      if (inStatus.has(r.path)) return;
      notes.push('numstat 里有、status 里没有的路径，已补进清单：' + r.path);
      rows.push({ path: r.path, status: 'M', add: r.add, del: r.del, binary: !!r.binary, src: 'numstat' });
    });

    rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { rows: rows, bad: bad, notes: notes };
  }

  /* ---------------- 记录（字段名**只在这里定义**） ---------------- */

  function buildRecord(o) {
    const e = o || {};
    const rec = {
      v: ENTRY_VERSION,
      seq: Number(e.seq) || 0,
      at: e.at || new Date().toISOString(),
      kind: e.kind === 'revert' ? 'revert' : 'change',
      path: String(e.path === undefined || e.path === null ? '' : e.path),
      status: String(e.status || 'M'),
      add: (e.add === undefined || e.add === null) ? null : Number(e.add),
      del: (e.del === undefined || e.del === null) ? null : Number(e.del),
      src: String(e.src || 'numstat')
    };
    if (e.binary) rec.binary = true;
    if (e.oldPath) rec.oldPath = String(e.oldPath);
    // 出处三件（**每条记录自带**，这样一条老记录也能自己说清"我当时是照着哪个 HEAD 采的"）
    if (e.root) rec.root = String(e.root);
    if (e.head !== undefined) rec.head = e.head === null ? null : String(e.head);
    if (e.trigger) rec.trigger = String(e.trigger);
    return rec;
  }

  function serializeRecord(r) { return JSON.stringify(r) + '\n'; }

  /** 判"这行像不像一条记录"（坏行不静默丢 ⇒ 解析结果里带 `badLines`） */
  function looksLikeRecord(o) {
    return !!o && typeof o === 'object' && typeof o.seq === 'number' && o.seq > 0
      && typeof o.path === 'string' && o.path !== '' && typeof o.status === 'string';
  }

  function parseLog(text) {
    const out = { records: [], badLines: [], total: 0 };
    const s = String(text === undefined || text === null ? '' : text);
    if (!s) return out;
    const lines = s.replace(/^\uFEFF/, '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      out.total++;
      let raw;
      try { raw = JSON.parse(line); } catch (err) { out.badLines.push(i + 1); continue; }
      if (!looksLikeRecord(raw)) { out.badLines.push(i + 1); continue; }
      out.records.push(buildRecord(raw));
    }
    return out;
  }

  /** 一条记录的"状态键"：**同路径同状态同行数**才算没变（重复采样不会重复记） */
  function recordKey(r) {
    const a = (r && r.add === null) ? '-' : String(r && r.add);
    const d = (r && r.del === null) ? '-' : String(r && r.del);
    return String((r && r.status) || '') + '|' + a + '|' + d;
  }

  /** 每个路径**最新那条**记录（→ Map，保持插入序） */
  function latestPerPath(records) {
    const map = new Map();
    (Array.isArray(records) ? records : []).forEach((r) => {
      if (!r || !r.path) return;
      map.set(r.path, r);
    });
    return map;
  }

  /**
   * 有界窗口裁剪 —— **但每个路径的最新一条必须活着**。
   * 为什么要这条保底：老记录被裁掉后，一个"早先改过、之后一直没再动"的文件会从 `latestPerPath` 里
   * 凭空消失 ⇒ 面板把"还在改"说成"没改"。裁剪是为了不无界增长，不是为了改变事实。
   */
  function compact(records, limit) {
    const list = Array.isArray(records) ? records.slice() : [];
    const max = Number(limit) > 0 ? Number(limit) : MAX_RECORDS;
    if (list.length <= max) return { records: list, dropped: 0 };
    const keep = new Set(list.slice(list.length - max));
    latestPerPath(list).forEach((rec) => { keep.add(rec); });
    const kept = list.filter((r) => keep.has(r));
    return { records: kept, dropped: list.length - kept.length };
  }

  /**
   * **纯函数**：给定"日志文本 + 这次采样的行"，算出该追加哪些记录、追加后的完整文本。
   *
   * 两条追加规则（都在这里，别处不判）：
   *   ① 路径的状态键与"该路径最新一条"不同 ⇒ 追加一条 `change`；
   *   ② 日志里说"改过"、但这次采样里**已经没有这个路径** ⇒ 追加一条 `revert`（`status:'='`）。
   *      少了它，一个"改了又改回去"的文件会永远挂在清单上（把"没改"说成"改了"）。
   *
   * @returns {{records:Array, nextText:string, added:number, reverted:number, dropped:number}}
   */
  function planAppend(text, rows, meta, opts) {
    const o = opts || {};
    const m = meta || {};
    const parsed = parseLog(text);
    const latest = latestPerPath(parsed.records);
    const lastSeq = parsed.records.reduce((mx, r) => (r.seq > mx ? r.seq : mx), 0);
    const present = new Map();
    (Array.isArray(rows) ? rows : []).forEach((r) => { if (r && r.path) present.set(r.path, r); });

    const fresh = [];
    let seq = lastSeq;
    present.forEach((r, p) => {
      const prev = latest.get(p);
      if (prev && recordKey(prev) === recordKey(r)) return;   // 没变 ⇒ 不重复记
      seq++;
      fresh.push(buildRecord({
        seq: seq, at: m.at, kind: 'change', path: p, status: r.status,
        add: r.add, del: r.del, binary: r.binary, src: r.src, oldPath: r.oldPath,
        root: m.root, head: m.head, trigger: m.trigger
      }));
    });
    let reverted = 0;
    latest.forEach((prev, p) => {
      if (present.has(p)) return;
      if (prev.status === '=') return;                        // 已经是冲销态 ⇒ 不重复记
      seq++;
      reverted++;
      fresh.push(buildRecord({
        seq: seq, at: m.at, kind: 'revert', path: p, status: '=',
        add: 0, del: 0, src: 'numstat', root: m.root, head: m.head, trigger: m.trigger
      }));
    });

    const all = parsed.records.concat(fresh);
    const c = compact(all, o.max);
    const added = fresh.filter((r) => r.kind !== 'revert').length;
    return {
      records: fresh,
      nextText: c.records.map(serializeRecord).join(''),
      added: added,
      reverted: reverted,
      dropped: c.dropped
    };
  }

  /** 人类可读的时间（`YYYY-MM-DD HH:MM:SS`，本机时区；只用于显示，不进判据） */
  function fmtAt(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return String(iso || '');
    const p = (n) => (n < 10 ? '0' + n : String(n));
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /**
   * 把记录折成"界面要显示的那一份"（**纯函数**；界面只显示，不自己再算一遍）。
   *
   * 口径逐字写进返回值（`unit` / `unitText` / `trace`），因为这是**唯一**能和内核那个数混淆的地方：
   * 我们记的是"相对 HEAD 的累计"，不是"本回合"。
   */
  function summarize(records) {
    const parsed = Array.isArray(records) ? records : [];
    const latest = latestPerPath(parsed);
    const rows = [];
    let newest = null;
    let newestWithHead = null;
    parsed.forEach((r) => {
      if (!newest || String(r.at) >= String(newest.at)) newest = r;
      // ⚠️ 冲销记录（`status:'='`）不带 head（它不对应任何一次 git 读数里的文件）⇒
      //    "这批数据采自哪一版"要取**最近一条真的带 head** 的记录，不能取最后一条。
      if (r.head && (!newestWithHead || String(r.at) >= String(newestWithHead.at))) newestWithHead = r;
    });
    latest.forEach((r, p) => {
      if (r.status === '=') return;                            // 已回到 HEAD ⇒ 不算"改了"
      rows.push({
        path: p,
        status: r.status,
        statusText: STATUS_TEXT[r.status] || r.status,
        add: r.add,
        del: r.del,
        binary: !!r.binary,
        src: r.src,
        srcText: SRC_TEXT[r.src] || r.src,
        at: r.at,
        atText: fmtAt(r.at),
        seq: r.seq
      });
    });
    rows.sort((a, b) => {
      const sa = (a.add === null ? -1 : a.add) + (a.del === null ? 0 : a.del);
      const sb = (b.add === null ? -1 : b.add) + (b.del === null ? 0 : b.del);
      if (sa !== sb) return sb - sa;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    const totals = { files: rows.length, added: 0, deleted: 0, binary: 0 };
    rows.forEach((r) => {
      if (r.binary) { totals.binary++; return; }
      if (typeof r.add === 'number') totals.added += r.add;
      if (typeof r.del === 'number') totals.deleted += r.del;
    });
    const head = newestWithHead ? String(newestWithHead.head) : null;
    const root = (newestWithHead && newestWithHead.root) || (newest && newest.root) || null;
    return {
      v: ENTRY_VERSION,
      unit: 'vs-head-cumulative',
      unitText: '相对 HEAD 的**累计**改动（不是"本回合"—— 本回合那个数在 kernel 卡片里，口径不同）',
      at: newest ? newest.at : null,
      atText: newest ? fmtAt(newest.at) : '',
      head: head,
      headShort: head ? head.slice(0, 8) : null,
      root: root,
      sourceText: 'git working tree（只读：不写 .git/index）',
      trace: {
        cwd: root,
        argv: 'git ' + GIT_ARGV.status.join(' ') + '   +   git ' + GIT_ARGV.numstat.join(' ')
      },
      rows: rows,
      totals: totals,
      observed: parsed.length,
      reverted: parsed.filter((r) => r.status === '=').length
    };
  }

  /* ============================================================
   * 三、git 采样（唯一实现；`runGit` / `readFile` 都可注入 ⇒ 单测能喂假读数）
   * ============================================================ */

  function defaultRunGit(args, cwd) {
    const { spawnSync } = require('child_process');
    const r = spawnSync('git', args, { cwd: cwd, encoding: 'utf8', windowsHide: true, env: Object.assign({}, process.env, GIT_ENV) });
    return {
      ok: r.status === 0,
      code: r.status === null ? -1 : r.status,
      stdout: r.stdout === null || r.stdout === undefined ? '' : r.stdout,
      stderr: r.stderr === null || r.stderr === undefined ? '' : r.stderr,
      spawnError: r.error ? String(r.error.code || r.error.message) : null
    };
  }

  /**
   * 读一个文件用来数行数（**只读**）。返回 `{ok:true, text, binary, size}` 或 `{ok:false, reason, size}`。
   *
   * 二进制判定 = 前 `COUNT_SNIFF_BYTES` 字节里出现 NUL（与 git 自己那只"前 8000 字节看有没有 NUL"
   * 的启发式同口径）。**为什么必须判**：未跟踪文件 git 不给 numstat，我们只能自己数；
   * 拿 utf8 去数一个二进制文件会得到"1 行"这种凭空数字（探针实测踩到，见 README 的偏差记录）。
   */
  function defaultReadFile(abs) {
    const fs = require('fs');
    const st = fs.statSync(abs);
    if (!st.isFile()) return { ok: false, reason: 'not-file', size: st.size };
    if (st.size > COUNT_MAX_BYTES) return { ok: false, reason: 'too-big', size: st.size };
    const buf = fs.readFileSync(abs);
    const binary = buf.subarray(0, COUNT_SNIFF_BYTES).indexOf(0) >= 0;
    return { ok: true, text: binary ? '' : buf.toString('utf8'), binary: binary, size: st.size };
  }

  /**
   * 采一次工作树快照（HEAD → 现在）。**唯一的 git 读取实现**。
   *
   * 三种"取不到"必须可分辨（绝不把"采不到"说成"没有改动"）：
   *   · `source:'no-git'`  —— 本机没有 git（spawn 失败）；
   *   · `source:'no-repo'` —— 目录不在任何 git 仓库里；
   *   · `source:'error'`   —— git 跑了但报错（带 stderr）。
   * 成功则是 `source:'git'` + `rows`（**空的 rows 才是真的"没有改动"**）。
   *
   * @param {{root:string, runGit?:Function, readFile?:Function, now?:string}} o
   */
  function readSnapshot(o) {
    const opt = o || {};
    const now = opt.now || new Date().toISOString();
    const run = typeof opt.runGit === 'function' ? opt.runGit : defaultRunGit;
    const read = typeof opt.readFile === 'function' ? opt.readFile : defaultReadFile;
    const rootIn = String(opt.root || '');
    const base = { at: now, rootInput: rootIn, repoRoot: null, head: null, rows: [], notes: [], bad: [] };
    if (!rootIn) return Object.assign(base, { ok: false, source: 'no-root', reason: '没有给出工作目录' });

    const rv = run(GIT_ARGV.repoRoot, rootIn);
    if (rv.spawnError) {
      return Object.assign(base, { ok: false, source: 'no-git', reason: 'git 起不来（' + rv.spawnError + '）' });
    }
    if (!rv.ok) {
      const err = String(rv.stderr || '').trim();
      const noRepo = /not a git repository/i.test(err);
      return Object.assign(base, {
        ok: false, source: noRepo ? 'no-repo' : 'error',
        reason: noRepo ? '这个目录不在任何 git 仓库里（' + rootIn + '）' : ('git rev-parse 失败：' + err),
        git: { repoRoot: { code: rv.code, stderr: err } }
      });
    }
    const repoRoot = String(rv.stdout).trim().split('\n')[0] || rootIn;

    const st = run(GIT_ARGV.status, repoRoot);
    if (st.spawnError || !st.ok) {
      return Object.assign(base, {
        ok: false, source: 'error', repoRoot: repoRoot,
        reason: 'git status 失败：' + String(st.stderr || st.spawnError || '').trim()
      });
    }
    const hd = run(GIT_ARGV.head, repoRoot);
    const head = hd.ok ? (String(hd.stdout).trim() || null) : null;
    const ns = run(GIT_ARGV.numstat, repoRoot);
    const notes = [];
    if (!ns.ok) {
      // 没有 HEAD（新建仓库）或别的 numstat 问题 ⇒ 全部走"文件行数"回退档，并**说出来**
      notes.push('git diff --numstat HEAD 不可用（' + (String(ns.stderr || '').trim().split('\n')[0] || ('exit ' + ns.code))
        + '）⇒ 行数改按文件行数计（该仓库可能还没有第一个提交）');
    }

    // 数行数：只对"git 不覆盖"的路径做（未跟踪 / 没 HEAD 时的全部）
    const statusParsed = parseStatusZ(st.stdout);
    const numstatPaths = new Set((ns.ok ? parseNumstatZ(ns.stdout).rows : []).map((r) => r.path));
    const counts = {};
    const skipped = [];
    const binaryPaths = [];
    statusParsed.rows.forEach((r) => {
      if (numstatPaths.has(r.path)) return;
      if (r.status === 'D') return;                     // 已删除的文件没得数（numstat 会给删行数）
      const abs = repoRoot.replace(/\/+$/, '') + '/' + r.path;
      let got;
      try { got = read(abs); } catch (e) { got = { ok: false, reason: String((e && e.message) || e) }; }
      if (got && got.ok && got.binary) {
        binaryPaths.push(r.path);
        notes.push('这个文件是二进制，行数留空（不是 0 行）：' + r.path);
      } else if (got && got.ok) {
        counts[r.path] = countLines(got.text);
      } else {
        skipped.push(r.path);
        notes.push('这个文件数不了行数，记录里如实留空：' + r.path
          + '（' + ((got && got.reason) || '读不到') + '）');
      }
    });

    const merged = mergeRows({
      statusText: st.stdout,
      numstatText: ns.stdout,
      numstatOk: ns.ok,
      lineCounts: counts,
      countSkipped: skipped,
      binaryPaths: binaryPaths,
      notes: notes
    });
    return Object.assign(base, {
      ok: true,
      source: 'git',
      repoRoot: repoRoot,
      head: head,
      rows: merged.rows,
      notes: merged.notes,
      bad: merged.bad,
      git: {
        repoRoot: { argv: GIT_ARGV.repoRoot, code: rv.code },
        status: { argv: GIT_ARGV.status, code: st.code, bytes: String(st.stdout).length, entries: statusParsed.rows.length },
        head: { argv: GIT_ARGV.head, code: hd.code },
        numstat: { argv: GIT_ARGV.numstat, code: ns.code, bytes: String(ns.stdout).length, ok: ns.ok }
      }
    });
  }

  /* ============================================================
   * 四、存储（**唯一写者**：本文件的 `record()` 经 `writeFileAtomic` 落盘；别处不许写这个文件）
   * ============================================================ */

  /**
   * @param {{file:string, writeFileAtomic:Function, fs?:object}} o
   *   `file` 由调用方（`main.js`）推导：正式 `<userData>/change-log.jsonl`、冒烟 `<沙箱根>/change-log.jsonl`。
   *   `writeFileAtomic` 必须来自 `src/data-store.js`（**不许**在这里自己写 tmp+rename —— 那是第二份原子写）。
   */
  function createStore(o) {
    const opt = o || {};
    const file = String(opt.file || '');
    const writeAtomic = opt.writeFileAtomic;
    if (!file) throw new Error('createStore 需要一个 file（路径由调用方推导，本模块不猜）');
    if (typeof writeAtomic !== 'function') {
      throw new Error('createStore 需要注入 writeFileAtomic（唯一原子写出口，来自 src/data-store.js）');
    }
    const fsMod = opt.fs || require('fs');
    const last = { at: null, head: null, added: 0, reverted: 0, trigger: null, source: null, seq: null };

    function read() {
      let text = '';
      let missing = false;
      try { text = fsMod.readFileSync(file, 'utf8'); } catch (e) {
        if (e && e.code === 'ENOENT') missing = true;
        else throw e;
      }
      const parsed = parseLog(text);
      return {
        ok: true, file: file, missing: missing, text: text,
        records: parsed.records, badLines: parsed.badLines, total: parsed.total
      };
    }

    /**
     * 采一次样并落盘（**唯一的写**）。没变化就**不写**（不动字节 ⇒ 也不改 mtime）。
     * @returns {{ok:boolean, added:number, reverted:number, reading:object, written:boolean, missing?:boolean}}
     */
    function record(rows, meta) {
      const cur = read();
      const plan = planAppend(cur.text, rows, meta, { max: MAX_RECORDS });
      const changed = plan.added + plan.reverted;
      let written = false;
      if (changed > 0 || cur.missing) {
        // 首采（文件还不存在）也写一次：**"采到了、确实没改动"**要留痕，不能靠"文件不存在"表达
        writeAtomic(file, plan.nextText);
        written = true;
      }
      const after = parseLog(plan.nextText);
      last.at = (meta && meta.at) || null;
      last.head = (meta && meta.head === undefined) ? null : (meta ? meta.head : null);
      last.added = plan.added;
      last.reverted = plan.reverted;
      last.trigger = (meta && meta.trigger) || null;
      last.source = (meta && meta.source) || null;
      last.seq = after.records.length ? after.records[after.records.length - 1].seq : null;
      return {
        ok: true, added: plan.added, reverted: plan.reverted, dropped: plan.dropped,
        written: written, missing: cur.missing,
        badLines: cur.badLines,
        reading: summarize(after.records)
      };
    }

    /** 只读：当前清单（**不采样、不写盘**） */
    function reading() {
      const cur = read();
      return summarize(cur.records);
    }

    /** 读数（判据/冒烟读它，不猜）：文件、条数、上一次写的账 */
    function status() {
      let cur;
      try { cur = read(); } catch (e) {
        return { ok: false, file: file, reason: String((e && e.message) || e) };
      }
      return {
        ok: true, file: file, missing: cur.missing, total: cur.total,
        records: cur.records.length, badLines: cur.badLines,
        last: Object.assign({}, last),
        reading: summarize(cur.records)
      };
    }

    return { file: file, read: read, record: record, reading: reading, status: status };
  }

  return {
    /* 常量（唯一定义处） */
    FILE_NAME, ENTRY_VERSION, MAX_RECORDS, SAMPLE_MIN_INTERVAL_MS, COUNT_MAX_BYTES, COUNT_SNIFF_BYTES,
    STATUS_TEXT, SRC_TEXT, GIT_ARGV, GIT_ENV,
    /* 纯函数 */
    normStatus, parseStatusZ, parseNumstatZ, countLines, mergeRows,
    buildRecord, serializeRecord, looksLikeRecord, parseLog, recordKey, latestPerPath,
    compact, planAppend, fmtAt, summarize,
    /* I/O（唯一实现） */
    readSnapshot, createStore, defaultRunGit, defaultReadFile
  };
});
