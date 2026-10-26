/* ============================================================
 * src/video-summary-probe.js — 视频摘要的**副作用面**（探字幕 / 探 ffmpeg / 读播放列表 / 可注入的执行器）
 * ------------------------------------------------------------
 * 为什么要与 `src/video-summary.js` 分开（本批成败的分界）：
 *   这台机器**没有 ffmpeg**（`Get-Command ffmpeg` 不存在）⇒ "选路正确"这件事**不可能**靠跑一遍证明。
 *   于是判断全在 `src/video-summary.js`（纯：不读盘、不起进程、不联网），副作用全在这里，
 *   并且**每一处副作用都能注入**（`opts.exists` / `opts.spawnSync` / `opts.pathEnv` / `opts.asr` / `opts.vision`）
 *   ⇒ 假的"有字幕/有 ffmpeg"、假的 ffmpeg 执行器都能在单测里喂进去。
 *
 * 本文件只做四件事（**不做任何判断** —— 判断一律回纯逻辑那一侧）：
 *   ① `findFfmpeg`     PATH 上有没有 `ffmpeg`（**不 spawn**：只看文件在不在，快且不产生进程）
 *   ② `probeReaders`   ASR / 视觉模型接没接（本批**未接** ⇒ 如实报 `available:false` + 原因）
 *   ③ `scanTarget`     把一个目录（或一份 `.m3u8`）走一遍：找到播放列表与字幕，读播放列表文本
 *   ④ `makeFfmpegRunner` / `ffmpegArgvOf`  ffmpeg 的**执行器骨架**：没装就 `{ok:false, reason:'ffmpeg-missing'}`，
 *                      装了才真的 spawn；**argv 的拼装是纯函数**（不跑也能断言它拼得对不对）。
 *                      五种活儿（`FFMPEG_MODES`）：`audio`（抽音轨）/ `frame`（等间隔）/
 *                      `frame-at` 与 `frame-at-accurate`（**按时间点抽一帧**，`-ss` 在 `-i` 前/后）/
 *                      `slice`（多模态 API 的切片）；另加两个纯助手 `hlsGuardArgsOf`（HLS 开门参数）
 *                      与 `frameTimesOf`（锚点 → 要抽帧的时间点，跳过/超限都如实报）。
 *
 * 五条硬纪律：
 *   · **不装 ffmpeg、不下载任何二进制、不联网**：本文件只"看"它在不在（那是用户的决定）；
 *   · **只读目标目录**：不写、不删、不碰 `projects/`（本命令是唯一不写项目的命令）；
 *   · 符号链接**不跟随**、隐藏项与依赖目录**跳过**（判据复用 `src/doc-import.js` 的 `entrySkipReason`
 *     —— 一处实现，不另写一份"哪些目录该跳过"的清单）；
 *   · 上限一律**响亮**（读不了/太大/太多 ⇒ 进 `gaps` 逐条点名，不静默丢）；
 *   · **顺序一律排序**（`rel` 码点序）⇒ `--json` 两跑逐字节相同（门禁 S3 的"顺序"那一类）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./doc-import.js'), require('./video-summary.js'), require('fs'), require('path'));
  } else {
    root.MMVideoSummaryProbe = factory(root.MMDocImport, root.MMVideoSummary, null, null);
  }
})(typeof self !== 'undefined' ? self : this, function (docImport, vs, fs, path) {
  'use strict';

  /* ==========================================================================
   * 0. 上限（**唯一一处**；撞上就点名，绝不静默截断）
   * ======================================================================== */

  const LIMITS = {
    MAX_DEPTH: 8,                 // 往下走几层（课程目录形状：<课>/<课时>/<名字>.m3u8/）
    MAX_DIRS: 4000,               // 最多走多少个目录（防一个误指到盘根的目标把进程拖死）
    MAX_PLAYLISTS: 200,           // 最多认多少份播放列表
    MAX_SUBTITLES: 200,           // 最多认多少份字幕
    MAX_PLAYLIST_BYTES: 8 * 1024 * 1024,   // 播放列表是**文本**；8 MB 已经远超任何真 HLS 播放列表
    MAX_SUBTITLE_BYTES: 4 * 1024 * 1024,
    FFMPEG_TIMEOUT_MS: 120000,    // 单次 ffmpeg 调用的上限（抽音轨/抽帧都可能慢，但不是"卡死"）
    FFMPEG_MAX_BUFFER: 8 * 1024 * 1024,
    /** `omni` 的切片长度（秒）：多模态 API 单次请求吃不下整门课。
     *  与 `src/video-summary.js` 的 `OMNI_SLICE_SEC` 是**同一个数**（那边是计划里的"口径"，
     *  这里是"缺省参数"）；测试逐条对拍，改一处漏一处会红。 */
    OMNI_SLICE_SEC: 600,
    FRAME_MIN_GAP_SEC: 5,         // 两个抽帧点至少隔 5 秒（更近的多半是同一张 PPT）
    FRAME_MAX: 60                 // 单次最多抽多少帧（撞上限要如实报 overMax，不许静默截断）
  };

  /** `ffmpegArgvOf` 的**唯一取值表**（新增一种活儿先加这里，别在别处现编字符串）。 */
  const FFMPEG_MODES = ['audio', 'frame', 'frame-at', 'frame-at-accurate', 'slice'];

  /** 探针自己的拒绝码 */
  const PROBE_CODES = {
    BAD_TARGET: 'bad-target',
    EMPTY_TARGET: 'empty-target',
    NO_VIDEO_OR_SUBTITLE: 'no-video-or-subtitle',
    FFMPEG_MISSING: 'ffmpeg-missing',
    TOO_BIG: 'too-big',
    UNREADABLE: 'unreadable'
  };

  const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  const str = (x) => (x === undefined || x === null ? '' : String(x));
  const num = (x) => (typeof x === 'number' && isFinite(x) ? x : 0);
  /** 一律走 posix 分隔符（判据与输出要跨平台一致：Windows 的 `\` 会让排序与正则各写一份） */
  const toSlash = (p) => str(p).replace(/\\/g, '/');
  const cmp = (a, b) => (a < b ? -1 : (a > b ? 1 : 0));

  /* ==========================================================================
   * 1. ffmpeg 在不在（**只看文件在不在，不 spawn**）
   * ======================================================================== */

  /**
   * PATH 上找 `ffmpeg`。**不执行它**（这也是本批的硬约束之一：没有装/没装成都不该因为"探一下"而多起进程）。
   *
   * @param {{pathEnv?:string, exists?:Function, platform?:string, exts?:string[]}} [opts]
   *   `pathEnv` / `exists` 都是**注入点**：单测里喂一份"假 PATH + 什么都不在"的读数，
   *   就能证明"没装 ffmpeg 时选路会怎么走"，**不需要真的装它**。
   * @returns {{found:boolean, path:string|null, searched:number, dirs:string[]}}
   */
  function findFfmpeg(opts) {
    const o = isObj(opts) ? opts : {};
    const exists = typeof o.exists === 'function' ? o.exists : fs.existsSync;
    const platform = str(o.platform) || process.platform;
    const pathEnv = o.pathEnv === undefined ? (process.env.PATH || process.env.Path || '') : str(o.pathEnv);
    const exts = Array.isArray(o.exts)
      ? o.exts.slice()
      : (platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']);
    const dirs = pathEnv.split(path.delimiter || (platform === 'win32' ? ';' : ':')).filter(Boolean);
    let searched = 0;
    for (let i = 0; i < dirs.length; i++) {
      for (let j = 0; j < exts.length; j++) {
        const cand = path.join(dirs[i], 'ffmpeg' + exts[j]);
        searched++;
        let hit = false;
        try { hit = exists(cand) === true; } catch (e) { hit = false; }
        if (hit) return { found: true, path: cand, searched: searched, dirs: dirs };
      }
    }
    return { found: false, path: null, searched: searched, dirs: dirs };
  }

  /* ==========================================================================
   * 2. 读内容的引擎（本批**未接**，接口位留在这一处）
   * ======================================================================== */

  /**
   * ASR / 视觉模型的可用性。**本批一律 `available:false`** —— 本批只做策略与适配器骨架，
   * 不接任何外部服务（那是另一个决定）。谎报 true 的后果是：详细档会"看起来做成了"，
   * 而 `highlights` 里其实是空话 ⇒ 这正是本工程最不能容忍的假绿。
   *
   * 单测靠注入（`opts.asr = {available:true}`）走通"有 ASR 时的步骤与降级分支"。
   *
   * ⚠️ `omni`（多模态 API 端到端）**今天没有自己的开关**：它落在 `vision` 这一位上
   * （"能读画面的多模态模型"）—— 选路只看"有没有能读画面的模型"，不看"那家是本地还是 API"
   * （接哪家是配置问题，不是能力问题）。真正要区分"本地视觉 vs omni API"时再加第五个布尔，
   * 那时 `selectMethod` 的矩阵要从 16 格变 32 格，必须同批改 `docs/VIDEO-NOTES.md` §3。
   */
  function probeReaders(opts) {
    const o = isObj(opts) ? opts : {};
    const asr = isObj(o.asr) ? o.asr : null;
    const vision = isObj(o.vision) ? o.vision : null;
    return {
      asr: asr
        ? { available: asr.available === true, name: str(asr.name) || 'injected-asr', injected: true }
        : { available: false, name: null, reason: 'asr-adapter-not-wired（本批只做骨架：不接外部服务）' },
      vision: vision
        ? { available: vision.available === true, name: str(vision.name) || 'injected-vision', injected: true }
        : { available: false, name: null, reason: 'vision-adapter-not-wired（本批只做骨架：不接外部服务）' }
    };
  }

  /* ==========================================================================
   * 3. 读播放列表 / 字幕（只读文本，且**都有上限**）
   * ======================================================================== */

  /** 读一小份文本文件（带上限）：读不了/太大 ⇒ `{ok:false, reason}`，**不抛** */
  function readSmallText(abs, maxBytes, fsIn) {
    const f = fsIn || fs;
    let st;
    try { st = f.statSync(abs); }
    catch (e) { return { ok: false, reason: PROBE_CODES.UNREADABLE, message: String((e && e.message) || e) }; }
    if (!st.isFile()) return { ok: false, reason: PROBE_CODES.UNREADABLE, message: '不是普通文件' };
    if (st.size > maxBytes) {
      return { ok: false, reason: PROBE_CODES.TOO_BIG,
        message: '这份文件 ' + st.size + ' 字节，超过读取上限 ' + maxBytes + ' 字节（**没有读它**）' };
    }
    let text;
    try { text = f.readFileSync(abs, 'utf8'); }
    catch (e) { return { ok: false, reason: PROBE_CODES.UNREADABLE, message: String((e && e.message) || e) }; }
    return { ok: true, text: str(text).replace(/^\uFEFF/, ''), bytes: st.size };
  }

  /** 一份播放列表 → 便宜的事实（**时长/分片数/是否加密的唯一实现**在 `src/doc-import.js`） */
  function readPlaylistFacts(abs, opts) {
    const o = isObj(opts) ? opts : {};
    const r = readSmallText(abs, o.maxBytes || LIMITS.MAX_PLAYLIST_BYTES, o.fs);
    if (!r.ok) return r;
    const facts = docImport.videoPlaylistFacts(r.text);
    return { ok: true, segments: facts.segments, seconds: facts.seconds, encrypted: facts.encrypted,
      bytes: r.bytes, text: r.text };
  }

  /** 一份字幕 → 原文（解析交给纯逻辑层：`src/video-summary.js` 的 `parseSubtitle`） */
  function readSubtitleText(abs, opts) {
    const o = isObj(opts) ? opts : {};
    const r = readSmallText(abs, o.maxBytes || LIMITS.MAX_SUBTITLE_BYTES, o.fs);
    if (!r.ok) return r;
    return { ok: true, text: r.text, bytes: r.bytes };
  }

  /* ==========================================================================
   * 4. 走查目标（目录或单份播放列表）
   * ======================================================================== */

  /**
   * 把一个目录（或一份 `.m3u8`）走一遍，**只认两样东西**：播放列表与字幕。
   * 分片（`.ts`）/密钥（`.key`）**一个都不读**（真实课程目录里那是 7.68 GB —— 摘要用不到它们）。
   *
   * 跳过判据**复用** `src/doc-import.js` 的 `entrySkipReason`（隐藏项 / 依赖目录 / 符号链接 / 非普通文件），
   * 不在这里另写一份"哪些目录该跳过"的清单（那就是第二份会漂的副本）。
   *
   * @returns {{ok:true, kind:'dir'|'playlist', root:string, target:string,
   *            videos:Array, subtitles:Array, gaps:Array, visited:object}|{ok:false, code, message}}
   */
  function scanTarget(target, opts) {
    const o = isObj(opts) ? opts : {};
    const f = o.fs || fs;
    const raw = str(target);
    if (!raw) {
      return { ok: false, code: PROBE_CODES.BAD_TARGET,
        message: '要一个目录或一份 `.m3u8` 播放列表的**路径**（不是项目名 —— 视频摘要不读 projects/）' };
    }
    let abs;
    try { abs = path.resolve(raw); } catch (e) {
      return { ok: false, code: PROBE_CODES.BAD_TARGET, message: '路径解析不了: ' + raw };
    }
    let st;
    try { st = f.statSync(abs); }
    catch (e) {
      return { ok: false, code: PROBE_CODES.BAD_TARGET,
        message: '这个路径不存在或读不到: ' + abs + '（' + ((e && e.code) || (e && e.message) || e) + '）' };
    }

    const videos = [], subtitles = [], gaps = [];
    const visited = { dirs: 0, entries: 0, truncated: false };

    /** 一份播放列表登记 */
    const addPlaylist = (absFile, relPath) => {
      if (videos.length >= LIMITS.MAX_PLAYLISTS) {
        gaps.push({ rel: toSlash(relPath), reason: 'too-many',
          message: '播放列表超过 ' + LIMITS.MAX_PLAYLISTS + ' 份 —— **没有继续收**（要更多请缩小目标目录）' });
        return;
      }
      const rel = toSlash(relPath);
      const facts = readPlaylistFacts(absFile, o);
      const name = path.basename(absFile);
      if (!facts.ok) {
        gaps.push({ rel: rel, reason: facts.reason, message: str(facts.message) });
        return;
      }
      videos.push({
        rel: rel, abs: absFile, name: name,
        topic: name.replace(/\.(m3u8|m3u)$/i, ''),
        segments: num(facts.segments), seconds: num(facts.seconds),
        encrypted: facts.encrypted === true, bytes: num(facts.bytes)
      });
    };

    /** 一份字幕登记 */
    const addSubtitle = (absFile, relPath) => {
      if (subtitles.length >= LIMITS.MAX_SUBTITLES) {
        gaps.push({ rel: toSlash(relPath), reason: 'too-many',
          message: '字幕超过 ' + LIMITS.MAX_SUBTITLES + ' 份 —— **没有继续收**（要更多请缩小目标目录）' });
        return;
      }
      let size = 0;
      try { size = f.statSync(absFile).size; } catch (e) { size = 0; }
      subtitles.push({ rel: toSlash(relPath), abs: absFile, name: path.basename(absFile),
        kind: vs.isSubtitleName(absFile) ? String(path.extname(absFile)).slice(1).toLowerCase() : 'unknown',
        bytes: size });
    };

    const isDir = (() => { try { return st.isDirectory(); } catch (e) { return false; } })();
    if (!isDir) {
      if (!docImport.isVideoEntryName(abs)) {
        if (vs.isSubtitleName(abs)) {
          addSubtitle(abs, path.basename(abs));
          return { ok: true, kind: 'subtitle-only', root: path.dirname(abs), target: abs,
            videos: videos, subtitles: subtitles, gaps: gaps, visited: visited };
        }
        return { ok: false, code: PROBE_CODES.BAD_TARGET,
          message: '这是一份文件，但既不是播放列表（`.m3u8`/`.m3u`）也不是字幕（`.vtt`/`.srt`）: '
            + path.basename(abs) + '。要整目录一起看：传**目录**路径。' };
      }
      addPlaylist(abs, path.basename(abs));
      return { ok: true, kind: 'playlist', root: path.dirname(abs), target: abs,
        videos: videos, subtitles: subtitles, gaps: gaps, visited: visited };
    }

    // ---- 目录：广度优先（**排序后**入队 ⇒ 两跑同一顺序；也避免深目录先撑爆栈）----
    const queue = [{ dir: abs, depth: 0, rel: '' }];
    while (queue.length) {
      const cur = queue.shift();
      if (cur.depth > LIMITS.MAX_DEPTH) {
        gaps.push({ rel: toSlash(cur.rel), reason: 'too-deep',
          message: '目录深度超过 ' + LIMITS.MAX_DEPTH + ' 层 —— **没有继续往下**' });
        continue;
      }
      if (visited.dirs >= LIMITS.MAX_DIRS) {
        visited.truncated = true;
        gaps.push({ rel: toSlash(cur.dir), reason: 'too-many', message: '目录数超过 ' + LIMITS.MAX_DIRS + ' —— **提前收工**' });
        break;
      }
      let ents;
      try { ents = f.readdirSync(cur.dir, { withFileTypes: true }); }
      catch (e) {
        gaps.push({ rel: toSlash(cur.rel || '.'), reason: PROBE_CODES.UNREADABLE,
          message: '读不了这个目录（' + ((e && e.code) || (e && e.message) || e) + '）' });
        continue;
      }
      visited.dirs++;
      ents.sort((a, b) => cmp(str(a.name), str(b.name)));
      for (let i = 0; i < ents.length; i++) {
        const e = ents[i];
        const skip = docImport.entrySkipReason(e);
        const relChild = cur.rel ? (cur.rel + '/' + e.name) : str(e.name);
        if (skip) { visited.entries++; continue; }
        const absChild = path.join(cur.dir, e.name);
        visited.entries++;
        if (e.isDirectory && e.isDirectory()) { queue.push({ dir: absChild, depth: cur.depth + 1, rel: relChild }); continue; }
        if (!(e.isFile && e.isFile())) continue;
        if (docImport.isVideoEntryName(e.name)) { addPlaylist(absChild, relChild); continue; }
        if (vs.isSubtitleName(e.name)) { addSubtitle(absChild, relChild); continue; }
        // 其余（.ts / .key / .txt / .pdf …）**一个都不读**：摘要用不到（分片 7.68 GB 不是摘要的输入）
      }
    }
    if (!videos.length && !subtitles.length) {
      return { ok: false, code: PROBE_CODES.NO_VIDEO_OR_SUBTITLE,
        message: '这个目录里**没有** `.m3u8`/`.m3u` 播放列表，也没有 `.vtt`/`.srt` 字幕'
          + '（走了 ' + visited.dirs + ' 个目录 / ' + visited.entries + ' 个条目，跳过判据与导入命令同一套：'
          + '隐藏项、依赖目录、符号链接都不跟）⇒ 没有可以摘要的东西' };
    }
    return { ok: true, kind: 'dir', root: abs, target: abs,
      videos: videos, subtitles: subtitles, gaps: gaps, visited: visited };
  }

  /* ==========================================================================
   * 5. 课程/课时层级（**只用目录名 + 播放列表里的时长**：这是粗档"不许解码"还能给出的信息）
   * ======================================================================== */

  /**
   * 从播放列表的相对路径推出**层级**：每条视频挂在它的父目录上，逐级汇总时长与份数。
   * 形状：`[{depth, path, name, videos, seconds, segments, encryptedAny}]`（按 `path` 码点序）。
   */
  function structureOf(videos, subtitles) {
    const map = new Map();
    /* 下载器把包建成 `<课时>/<名字>.m3u8/` ⇒ 那一层**不是课程层级**，是播放器的中间目录：
     * 从"课程/课时层级"里把它摘掉（否则层级里会多出一层 `学习中心.m3u8`，而它其实就是这个视频本身）。 */
    const dirSegsOf = (rel) => toSlash(rel).split('/').filter(Boolean).slice(0, -1)
      .filter((s) => !docImport.isVideoBundleName(s));
    const touch = (segs) => {
      let acc = '';
      for (let i = 0; i < segs.length; i++) {
        acc = acc ? (acc + '/' + segs[i]) : segs[i];
        if (!map.has(acc)) map.set(acc, { depth: i, path: acc, name: segs[i], videos: 0, seconds: 0, segments: 0, subtitles: 0 });
      }
    };
    (Array.isArray(videos) ? videos : []).forEach((v) => {
      const segs = dirSegsOf(v.rel);
      if (!segs.length) return;                          // 目标根下的播放列表：没有子层级，不进 structure
      touch(segs);
      let acc = '';
      for (let i = 0; i < segs.length; i++) {
        acc = acc ? (acc + '/' + segs[i]) : segs[i];
        const node = map.get(acc);
        if (node) { node.videos += 1; node.seconds += num(v.seconds); node.segments += num(v.segments); }
      }
    });
    (Array.isArray(subtitles) ? subtitles : []).forEach((s) => {
      const segs = dirSegsOf(s.rel);
      if (!segs.length) return;
      touch(segs);
      let acc = '';
      for (let i = 0; i < segs.length; i++) {
        acc = acc ? (acc + '/' + segs[i]) : segs[i];
        const node = map.get(acc);
        if (node) node.subtitles += 1;
      }
    });
    const out = [];
    map.forEach((v) => out.push(v));
    out.sort((a, b) => cmp(a.path, b.path));
    // 加密标记：这一层（含下面各层）里有没有带 EXT-X-KEY 的播放列表
    const encDirs = new Set();
    (Array.isArray(videos) ? videos : []).forEach((v) => {
      if (v.encrypted !== true) return;
      const segs = dirSegsOf(v.rel);
      let acc = '';
      for (let i = 0; i < segs.length; i++) { acc = acc ? (acc + '/' + segs[i]) : segs[i]; encDirs.add(acc); }
    });
    out.forEach((v) => { v.encryptedAny = encDirs.has(v.path); });
    return out;
  }

  /* ==========================================================================
   * 6. 一次探完（命令层只调这一个）
   * ======================================================================== */

  /**
   * 探针的**唯一入口**：目标 → 一份"事实包"（`planStrategy` 的入参）。
   *
   * 事实包里**没有内容**（没有字幕正文、没有画面）：粗档只需要这些，详细档由命令层按计划再去读字幕。
   * 这一点很重要 —— 它保证"coarse 档不读字幕正文"不是靠自觉，而是**拿不到**。
   *
   * @returns {{ok:true, target, kind, topic, videos, subtitles, structure, totals, caps, gaps, visited}
   *          |{ok:false, code, message}}
   */
  function probeVideo(target, opts) {
    const o = isObj(opts) ? opts : {};
    const scan = scanTarget(target, o);
    if (!scan.ok) return scan;
    const videos = scan.videos.slice().sort((a, b) => cmp(a.rel, b.rel));
    const subtitles = scan.subtitles.slice().sort((a, b) => cmp(a.rel, b.rel));
    const seconds = videos.reduce((n, v) => n + num(v.seconds), 0);
    const segments = videos.reduce((n, v) => n + num(v.segments), 0);
    const readers = probeReaders(o);
    const ff = typeof o.ffmpeg === 'object' && o.ffmpeg !== null ? o.ffmpeg : findFfmpeg(o);
    const caps = {
      ffmpeg: { found: ff.found === true, path: ff.path || null, searched: num(ff.searched) },
      asr: readers.asr,
      vision: readers.vision
    };
    // 一句话主题：只有一份播放列表 ⇒ 用它（去扩展名）；否则用目标目录名（**只取名，不当摘要**）
    const topic = videos.length === 1 ? videos[0].topic
      : (path.basename(scan.root) || path.basename(scan.target));
    return {
      ok: true,
      target: scan.target,
      kind: scan.kind,
      root: scan.root,
      topic: topic,
      videos: videos,
      subtitles: subtitles,
      structure: structureOf(videos, subtitles),
      totals: {
        videos: videos.length, subtitles: subtitles.length,
        seconds: Math.round(seconds), segments: segments,
        encrypted: videos.some((v) => v.encrypted === true),
        // "真值口径"写在返回值里：时长是 `#EXTINF` 之和（**不需要 ffmpeg** 就能算，见 doc-import）
        durationFrom: 'playlist-extinf-sum'
      },
      caps: caps,
      gaps: scan.gaps.slice().sort((a, b) => cmp(str(a.rel) + str(a.reason), str(b.rel) + str(b.reason))),
      visited: scan.visited
    };
  }

  /** 按计划去读字幕**正文**（只有详细档的 subtitle/hybrid 那一支才会调它） */
  function collectSubtitleTexts(facts, opts) {
    const o = isObj(opts) ? opts : {};
    const subs = (isObj(facts) && Array.isArray(facts.subtitles)) ? facts.subtitles : [];
    const texts = [], gaps = [];
    subs.forEach((s) => {
      const abs = s && s.abs ? str(s.abs) : '';
      if (!abs) { gaps.push({ rel: str(s && s.rel), reason: PROBE_CODES.UNREADABLE, message: '没有绝对路径' }); return; }
      const r = readSubtitleText(abs, o);
      if (!r.ok) { gaps.push({ rel: str(s.rel), reason: r.reason, message: str(r.message) }); return; }
      texts.push({ rel: str(s.rel), text: r.text });
    });
    return { texts: texts, gaps: gaps };
  }

  /* ==========================================================================
   * 7. ffmpeg 适配器（**骨架 + 明确的失败**；argv 拼装是纯函数 ⇒ 不跑也能断言）
   * ======================================================================== */

  /**
   * ffmpeg 要跑的几段活（argv 拼装是**纯函数** ⇒ 不装 ffmpeg 也能断言它拼得对不对）：
   *   · `audio`             抽一条 16 kHz 单声道 wav（给 ASR 用）
   *   · `frame`             按固定间隔抽帧（给视觉模型读画面里的字；**旧口径，正在被下面两条取代**）
   *   · `frame-at`          **按时间点抽一帧**，`-ss` 在 `-i` **前**（输入定位：快，逐点代价 ≤ 一个分片）
   *   · `frame-at-accurate` 同上，但 `-ss` 在 `-i` **后**（输出定位：从片头解到该点，慢但不受定位影响）
   *   · `slice`             按时间窗切一段音频（`omni` 的 10 分钟切片）
   *
   * ⚠️ `-ss` 前/后的**精度差别不是 folklore 说的那样**（详见 `docs/VIDEO-NOTES.md` §4）：
   *   · `-ss` 作为输入选项时 ffmpeg 只能定位到"该点所在的关键帧/分片"，**默认开启的 `-accurate_seek`
   *     会把关键帧到目标点之间的内容解码后丢弃** ⇒ 出帧时刻通常是准的，省的是"不必从片头解"；
   *   · 真正会"差几秒"的是 `-noaccurate_seek`（或 `-c copy` 这类流拷贝）——那时输出就停在定位点上。
   *   ⇒ 我们的默认选 `frame-at`（逐点抽帧时后者会把整片解 N 遍）；`frame-at-accurate` 留作对拍用。
   *
   * @param {string} kind 见上（`FFMPEG_MODES` 是唯一取值表）
   * @param {string} inputAbs 播放列表/视频文件
   * @param {string} outAbs   输出（`frame` 那一档要带 `%03d`，ffmpeg 自己编号）
   * @param {object} [opts]   `everySec`/`maxFrames`（frame）、`atSec`（frame-at*）、`startSec`/`durSec`（slice）
   * @returns {string[]} argv（**不含可执行文件本身** —— 可执行文件由执行器决定）
   */
  function ffmpegArgvOf(kind, inputAbs, outAbs, opts) {
    const o = isObj(opts) ? opts : {};
    const inp = str(inputAbs);
    // HLS 的"开门参数"（见 `hlsGuardArgsOf`）：必须在 `-i` **之前**，否则 ffmpeg 已经按默认白名单拒了
    const guard = hlsGuardArgsOf(inp);
    const head = ['-hide_banner', '-nostdin', '-y'];
    if (kind === 'audio') {
      return head.concat(guard, ['-i', inp, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', str(outAbs)]);
    }
    if (kind === 'frame') {
      const every = num(o.everySec) > 0 ? num(o.everySec) : 10;
      const maxFrames = num(o.maxFrames) > 0 ? num(o.maxFrames) : 60;
      return head.concat(guard, ['-i', inp, '-vf', 'fps=1/' + every, '-frames:v', String(maxFrames), str(outAbs)]);
    }
    if (kind === 'frame-at') {
      const at = secArg(o.atSec);
      return head.concat(guard, ['-ss', at, '-i', inp, '-frames:v', '1', str(outAbs)]);
    }
    if (kind === 'frame-at-accurate') {
      const at = secArg(o.atSec);
      return head.concat(guard, ['-i', inp, '-ss', at, '-frames:v', '1', str(outAbs)]);
    }
    if (kind === 'slice') {
      const start = secArg(o.startSec);
      const dur = num(o.durSec) > 0 ? num(o.durSec) : LIMITS.OMNI_SLICE_SEC;
      return head.concat(guard, ['-ss', start, '-t', secArg(dur), '-i', inp,
        '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', str(outAbs)]);
    }
    throw new Error('ffmpegArgvOf 只认 ' + FFMPEG_MODES.join(' / ') + '，收到 ' + JSON.stringify(kind));
  }

  /** 秒 → argv 里的字符串（3 位小数；固定写法 ⇒ 两次拼出来的 argv 逐字节相同，可当判据比） */
  function secArg(x) {
    const v = num(x);
    return String(Math.round(v * 1000) / 1000);
  }

  /**
   * **HLS 的"开门参数"**：本地 `.m3u8`（我们真实的输入形状，见 `docs/VIDEO-NOTES.md` §7）默认**打不开**。
   * 两个已知的门：
   *   · 段/密钥的扩展名不在 HLS 解复用器的默认白名单里（默认表不含 `key`）⇒ `-allowed_extensions ALL`；
   *   · AES-128 解密要走 `crypto` 协议、读本地密钥要走 `file` 协议，而 ffmpeg 对"输入里出现的协议"
   *     有白名单（实测社区报错原文形如 `Protocol not on whitelist 'file,crypto'`）⇒
   *     `-protocol_whitelist file,crypto,data`。
   * ⚠️ **本机没有 ffmpeg，这两条 argv 未实测**（`docs/VIDEO-NOTES.md` §7.2 明写"未实测"）：
   *   它们是**按查到的资料拼出来的候选**，不是"已验证能用"。真正的判据是装好 ffmpeg 后跑一次。
   * 非 HLS 输入（`.mp4` 等）⇒ 返回 `[]`（不给 mp4 加这些参数：那会让命令看起来像"必须这么写"）。
   */
  function hlsGuardArgsOf(inputAbs) {
    const s = toSlash(str(inputAbs)).toLowerCase();
    const isHls = /\.m3u8?$/.test(s);
    return isHls ? ['-allowed_extensions', 'ALL', '-protocol_whitelist', 'file,crypto,data'] : [];
  }

  /**
   * 锚点 → **要抽帧的时间点**（纯函数，`docs/VIDEO-NOTES.md` §4 的"按知识点抽帧"落地那一半）。
   *
   * 规则：按 `at` 升序；与前一个已选点相距 < `minGapSec` 的**跳过**（同一个知识点的连续两句
   * 抽出来是同一张 PPT）；最多 `maxFrames` 个。**跳过与撞上限都如实报出来**（`dropped`），
   * 不静默截断 —— 静默截断会让"抽了 60 张"看起来像"全部知识点都抽了"。
   *
   * @param {Array<{at:number, atText?:string, text?:string}>} anchors `src/video-summary.js` 的 `anchors`
   * @param {{minGapSec?:number, maxFrames?:number}} [opts]
   * @returns {{times:Array<{at:number, atText:string, text:string}>, dropped:{tooClose:number, overMax:number}}}
   */
  function frameTimesOf(anchors, opts) {
    const o = isObj(opts) ? opts : {};
    const gap = num(o.minGapSec) > 0 ? num(o.minGapSec) : LIMITS.FRAME_MIN_GAP_SEC;
    const max = num(o.maxFrames) > 0 ? num(o.maxFrames) : LIMITS.FRAME_MAX;
    const list = (Array.isArray(anchors) ? anchors : [])
      .map((a) => ({ at: num(isObj(a) ? a.at : a), atText: str(isObj(a) ? (a.atText || '') : ''),
        text: str(isObj(a) ? (a.text || '') : '') }))
      .filter((a) => isFinite(a.at) && a.at >= 0)
      .sort((a, b) => a.at - b.at);
    const times = [];
    const dropped = { tooClose: 0, overMax: 0 };
    let last = null;
    list.forEach((a) => {
      if (last !== null && a.at - last < gap) { dropped.tooClose++; return; }
      if (times.length >= max) { dropped.overMax++; return; }
      times.push(a);
      last = a.at;
    });
    return { times: times, dropped: dropped };
  }

  /**
   * 造一个执行器。**没装 ffmpeg ⇒ 每次 `run` 都返回
   * `{ok:false, reason:'ffmpeg-missing'}`**（明确失败，不抛、不装作跑过）。
   *
   * @param {{ffmpeg?:object, spawnSync?:Function, timeoutMs?:number}} [opts] 全部可注入（单测喂假执行器）
   */
  function makeFfmpegRunner(opts) {
    const o = isObj(opts) ? opts : {};
    const found = isObj(o.ffmpeg) ? o.ffmpeg : findFfmpeg(o);
    const spawn = typeof o.spawnSync === 'function' ? o.spawnSync
      : (() => { try { return require('child_process').spawnSync; } catch (e) { return null; } })();
    return {
      available: found.found === true,
      path: found.path || null,
      /**
       * @param {string[]} argv
       * @returns {{ok:true, status:number, stdout:string, stderr:string}|{ok:false, reason:string, message:string}}
       */
      run(argv) {
        if (found.found !== true) {
          return { ok: false, reason: PROBE_CODES.FFMPEG_MISSING,
            message: '本机没有 ffmpeg（PATH 上找不到 `ffmpeg`）⇒ 这一路跑不动。'
              + '装不装是用户的决定：装好后重跑，或改用 `--method subtitle` / `--level coarse`' };
        }
        if (typeof spawn !== 'function') {
          return { ok: false, reason: 'spawn-unavailable', message: '拿不到子进程入口（spawnSync 不存在）' };
        }
        const r = spawn(found.path, argv, {
          encoding: 'utf8',
          timeout: num(o.timeoutMs) > 0 ? num(o.timeoutMs) : LIMITS.FFMPEG_TIMEOUT_MS,
          maxBuffer: LIMITS.FFMPEG_MAX_BUFFER
        }) || {};
        if (r.error) return { ok: false, reason: 'spawn-failed', message: str(r.error.message || r.error) };
        const stdout = str(r.stdout), stderr = str(r.stderr);
        if (r.status !== 0) {
          return { ok: false, reason: 'ffmpeg-failed',
            message: 'ffmpeg 退出码 ' + JSON.stringify(r.status) + '：' + stderr.split(/\r?\n/).slice(-3).join(' ').trim() };
        }
        return { ok: true, status: num(r.status), stdout: stdout, stderr: stderr };
      }
    };
  }

  /** 跑计划里的解码那一步（`degraded` 的计划**不会**有这一步 —— 由纯逻辑层决定，本函数只执行） */
  function runFfmpegStep(runner, kind, inputAbs, outAbs, opts) {
    if (!runner) return { ok: false, reason: 'no-runner', message: '没有执行器' };
    if (!runner.available) {
      return { ok: false, reason: PROBE_CODES.FFMPEG_MISSING,
        message: '本机没有 ffmpeg（PATH 上找不到 `ffmpeg`）⇒ 这一路跑不动' };
    }
    const argv = ffmpegArgvOf(kind, inputAbs, outAbs, opts);
    const r = runner.run(argv);
    if (!r.ok) return { ok: false, reason: r.reason, message: r.message, argv: argv };
    return { ok: true, argv: argv, out: str(outAbs), stdout: r.stdout, stderr: r.stderr, kind: kind };
  }

  return {
    // 上限与拒绝码（唯一一处）
    LIMITS, PROBE_CODES, FFMPEG_MODES,
    // ① 探 ffmpeg（不 spawn）/ ② 探读内容的引擎
    findFfmpeg, probeReaders,
    // ③ 读文本（带上限）
    readSmallText, readPlaylistFacts, readSubtitleText,
    // ④ 走查目标 / ⑤ 层级
    scanTarget, structureOf,
    // ⑥ 一次探完
    probeVideo, collectSubtitleTexts,
    // ⑦ ffmpeg 适配器（骨架 + 明确失败；argv 拼装纯函数）
    ffmpegArgvOf, hlsGuardArgsOf, frameTimesOf, makeFfmpegRunner, runFfmpegStep
  };
});
