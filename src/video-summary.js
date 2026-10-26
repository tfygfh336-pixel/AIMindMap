/* ============================================================
 * src/video-summary.js — 「视频摘要：三条路 + 两档 + 自动检测」的**判据唯一实现处**
 * ------------------------------------------------------------
 * UMD 纯逻辑：**零 I/O、零时钟、零随机、零进程**（Node 侧 CLI/MCP 与单测共用一份；
 * 浏览器侧没人加载它，但双端加载必须成立 —— 见 `docs/ARCHITECTURE.md` §2.3 / §8.4）。
 *
 * ## 它回答的三个问题（用户原话，2026-10-48）
 *   ① **三条路都要实现**：字幕解析 / ffmpeg（解码）/ 二者结合（hybrid）
 *   ② **可以选择用什么方法**（`--method auto|subtitle|ffmpeg|hybrid`）
 *   ③ **可以自动检测**这段视频能用什么方法，**并说清为什么选了它**（`why`）
 *   外加档位：`--level coarse|detailed` 两档，各自的**产出契约写死在本文件的 `LEVEL_CONTRACT`**。
 *
 * ## 为什么本文件是**纯的**（本批成败的分界）
 * 这台机器**没装 ffmpeg**（`Get-Command ffmpeg` 不存在）⇒ 任何"顺手起个进程试试"的写法都跑不动。
 * 于是把两件事**彻底分开**：
 *   · **本文件**只做判断与合成 —— 喂一份 `{caps:{hasSubtitle:false, hasFfmpeg:false}}` 就能把
 *     "没装 ffmpeg 时会选哪条、会怎么拒绝、粗档会长什么样"全部单测完（`tests/video-summary.test.js`）；
 *   · **`src/video-summary-probe.js`** 才是副作用面（探字幕、探 ffmpeg、读播放列表、可注入的执行器）。
 * ⇒ 「没装 ffmpeg 也能证明选路正确」这一条**只可能**靠这条分界成立；混在一起就永远只能靠装它来验。
 *
 * ## 三条硬纪律（写在这里，改之前先读）
 *   ① **`--method` 显式指定时绝不静默回退**：要的那条不可用 ⇒ `{ok:false}` + 说清"现在可用的是哪条"。
 *      静默回退是**本批最不能犯的错** —— 用户明确选了方法，回退等于骗他（见 `explicitRefusal`）。
 *   ② **`detailed` 在"无字幕 + 无 ffmpeg"时必须是明确失败**（`no-content-source`），
 *      绝不拿文件名/目录名拼一份"看着像详细"的摘要 —— 那是本工程最不能容忍的假绿。
 *   ③ **`coarse` 的 steps 里不许出现解码 / 抽帧 / 转写 / 起进程**：这是**结构判据**
 *      （`COARSE_FORBIDDEN_STEPS` + `checkSummary`），不是嘴上说说 —— 偷偷加一步就红。
 *
 * ## 四条路（2026-10-55 扩：在原来的"三条路"之上加一条折中）
 * 设计文档：`docs/VIDEO-NOTES.md`（**每条路的输入/输出/代价写在那一处**；本文件只放判据与接口）。
 * 术语沿用既有的，**不另造新词**：
 *   · `subtitle`  —— 只吃 `.vtt/.srt`（`parseSubtitle`，现在就能真做）；
 *   · `local-asr` —— ffmpeg 抽音轨（`-vn -ac 1 -ar 16000`）→ VAD 分段 → 本地 ASR → 句级 `[start,end,text]`；
 *   · `omni`      —— ffmpeg 按 10 分钟切片 → 多模态 API 端到端（转写 + 摘要 + 图文绑定一步出）；
 *   · `mixed`     —— `local-asr` 出时间戳文本 + `omni` 只做总结与图文绑定（**用户点名推荐**的折中）。
 * ⚠️ **路(`METHOD_KINDS`)与"用户能点的方法"(`METHODS`)是两个取值域**，别混：
 *   `--method` 今天仍是 `auto|subtitle|ffmpeg|hybrid` 四个值（**改它要同批改 `cli/registry.js` 的
 *   usage/desc 并重生成 `docs/CLI.md`**，属实现批）；新增的三条是**选路结论**，
 *   由能力矩阵判出来、写在 `plan.method` / `plan.selection.method` / `plan.via` 里。
 *   `--method ffmpeg` 指的是**解码族**（`local-asr`/`omni`/`mixed`/无读引擎的 `ffmpeg` 兜底），
 *   族内选哪条由能力决定并如实报在 `via`；**绝不跨族**（点了解码族就绝不会跑去字幕族）。
 *
 * ## 与既有件的分工（别在别处再写一遍）
 *   · `src/doc-import.js`：**播放列表里便宜的事实**（`videoPlaylistFacts`：`#EXTINF` 求和 / 分片数 /
 *     是否加密）与**秒数格式化**（`formatDuration`）的唯一实现处。本文件**不重算**这两件事：
 *     时长由探针读盘后交给 `doc-import` 的口径算，时间戳格式化直接复用 `formatDuration`
 *     （`formatStamp` 是它的薄包装；第二份"看着一样"的实现必然漂移 ✗）。
 *   · `.vtt` 在 `classifyVideoPart` 眼里是"HLS 包里的分片"（既有语义，有断言钉着，**本批不动**）。
 *     摘要这一侧的判据**另走一套**：`.vtt`/`.srt` = **字幕**（`SUBTITLE_EXT`）。两套判据的差别是
 *     **用途**，不是矛盾：导入那一步 `classifyVideoPart` 管"要不要导进树"，本模块管"能不能拿它做摘要"。
 *     两侧都有断言（见 `tests/video-summary.test.js` 的 A5）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./doc-import.js'));
  else root.MMVideoSummary = factory(root.MMDocImport || null);
})(typeof self !== 'undefined' ? self : this, function (docImport) {
  'use strict';

  /* ==========================================================================
   * 0. 取值表（**唯一一处**：档位 / 方法 / 步骤种类 / 拒绝码 / 契约）
   * ======================================================================== */

  /** 档位（`--level`）。**粗档是默认档**：它永远做得到，而详细档需要内容源 ——
   *  把"可能诚实地失败"的那一档设成默认，等于让每个用户先撞一次墙。 */
  const LEVELS = ['coarse', 'detailed'];
  const DEFAULT_LEVEL = 'coarse';

  /** `--method` 的**取值**（含 `auto`）。`coarse-only` 不在这里：它不是用户能选的"方法"，
   *  而是**选路结论**（"哪条都不可用"），见 `METHOD_KINDS`。
   *  ⚠️ **本批有意不扩这个表**：它同时出现在 `cli/registry.js` 的 usage/desc 与生成物 `docs/CLI.md` 里，
   *  扩它必须同批重生成文档（`docs-gen`）；而新增的三条路**今天一条也跑不起来**（没 ffmpeg、ASR/视觉没接）
   *  ⇒ 先把它们做成"选路结论"（可测、可解释），等适配器接上再开 `--method` 的取值。 */
  const METHODS = ['auto', 'subtitle', 'ffmpeg', 'hybrid'];
  const DEFAULT_METHOD = 'auto';

  /** 选路结论的取值域（`plan.method` / `plan.selection.method`）。
   *  三条路（`subtitle` / `local-asr` / `omni`）+ 一条折中（`mixed`）+ 两个历史值
   *  （`hybrid` = 字幕+视觉两条拼起来；`ffmpeg` = 解码族的**兜底格**：能解码、但没谁读）
   *  + `coarse-only`（哪条都不可用 ⇒ 只能粗档）。 */
  const METHOD_KINDS = ['subtitle', 'ffmpeg', 'hybrid', 'local-asr', 'omni', 'mixed', 'coarse-only'];

  /** **解码族**：这几条都要先过 ffmpeg（抽音轨 / 抽帧 / 切片）。显式 `--method ffmpeg` 点的是这一族。 */
  const DECODE_KINDS = ['ffmpeg', 'local-asr', 'omni', 'mixed'];

  /** 选路矩阵的**四个轴**（穷举 = 2^4 = 16 格；`selectMethod` 对这 16 格**全是全函数**）。
   *  导出它只是为了让"穷举"有个单一来源（测试与文档都照这张轴表枚举，不各写一份）。 */
  const MATRIX_AXES = ['hasSubtitle', 'hasFfmpeg', 'hasAsr', 'hasVision'];

  /** 计划里的**步骤种类**（`plan.steps[].kind`）。判据只认这张表，不许现编字符串。
   *  `bind` = "知识点 ↔ 同期关键帧"的配对（`omni`/`mixed` 的**定义性产物**，见 `docs/VIDEO-NOTES.md`）。 */
  const STEP_KINDS = ['read-playlist', 'read-subtitle', 'decode', 'frame', 'transcribe', 'bind',
    'compose-coarse', 'compose-detailed'];

  /** **粗档禁止出现的步骤种类**（结构判据：不是"约定"，是 `checkSummary` 直接判红的东西）。
   *  `spawn` 也在里面：哪怕某天有人把"起个进程问一句话"包装成别的 kind 名字，
   *  "起进程"这件事本身在粗档也是禁止的。`bind` 同理：配对是"看过画面"才做得到的事。 */
  const COARSE_FORBIDDEN_STEPS = ['decode', 'frame', 'transcribe', 'bind', 'spawn'];

  /** 抽音轨的**标准形状**（`local-asr` / `mixed` 共用；与 `src/video-summary-probe.js` 的
   *  `ffmpegArgvOf('audio')` 是同一件事的两面：这里是"契约值"，那里是"argv 拼装"）。
   *  为什么要单列：`-ac 1 -ar 16000` 是**语音识别的输入前提**，不是可调参数 —— 采样率不对，
   *  ASR 会"听起来正常但识别出一堆错字"，而且**不会报错**（最难发现的那一类失败）。 */
  const ASR_AUDIO = { channels: 1, sampleRate: 16000 };

  /** VAD 分段的**窗口**（每段 30 秒 ~ 10 分钟）。
   *  为什么要 VAD：Whisper 系在**长静音**上会复读/幻觉（把静音"翻译"成一句不存在的话），
   *  切掉静音 + 限段长是工程上公认的止血手段；上限 10 分钟是"再长就没人愿意重跑一段"的取舍。
   *  出处与代价：`docs/VIDEO-NOTES.md` §5（**本节不复述理由**，只给数值 —— 数值改了要两处一起改）。 */
  const VAD_SEGMENT_SEC = { min: 30, max: 600 };

  /** `omni` 的切片长度：多模态 API 单次请求吃不下整门课 ⇒ 按 10 分钟切片（600 秒）。 */
  const OMNI_SLICE_SEC = 600;

  /** 拒绝码（`{ok:false, code}`）—— 调用方按它出报文/测试按它钉判据，**不认散字符串**。 */
  const CODES = {
    BAD_ARGS: 'bad-args',
    BAD_LEVEL: 'bad-level',
    BAD_METHOD: 'bad-method',
    METHOD_NEEDS_DETAILED: 'method-needs-detailed',
    METHOD_UNAVAILABLE: 'method-unavailable',
    HYBRID_NEEDS_BOTH: 'hybrid-needs-both',
    NO_CONTENT_SOURCE: 'no-content-source',
    NO_CONTENT_READER: 'no-content-reader',
    NO_CUES: 'no-cues',
    CONTRACT_BROKEN: 'contract-broken',
    BAD_PLAN: 'bad-plan'
  };

  /** `why` 必须**提到判据依据**（这条是机械判据，见 `judgeWhy`）：
   *  `why='hybrid'` 这种"等于没说"的答案要被判红，所以这里给的是**证据词表**。 */
  const WHY_EVIDENCE_WORDS = ['字幕', 'ffmpeg', 'ASR', '视觉', '粗档', 'coarse', '解码'];
  const WHY_MIN_CHARS = 12;

  /**
   * 档位契约（**产出契约的唯一权威**）：每档"必须产出什么 / 不许做什么"。
   *  `required` = 必须出现的键（缺一个就 `contract-broken`）；
   *  `forbiddenStepKinds` = steps 里不许出现的步骤种类；
   *  `mustNot` = 不该出现的**内容层产物**（粗档不许有逐段要点 —— 有就是"偷偷做了 detailed 的活"）；
   *  `methodRequired`（**只有详细档有**）= **按选路结论追加**的必备键 —— 同一条 detailed，
   *  走 `local-asr` 与走 `omni` 该交的东西**不一样**（前者必须给"时间点锚点"，后者必须给"图文绑定"）。
   *  这一层不做成"一个大 required 列表"的理由：那会逼所有路都产出别人的产物，
   *  于是最省事的实现就是把空数组塞进去 —— **契约变成形式**，正是本工程最不能容忍的那种绿。
   */
  const LEVEL_CONTRACT = {
    coarse: {
      level: 'coarse',
      title: '粗档',
      what: '结构 + 时长 + 片数 + 是否加密 + 课程/课时层级 + 一句话主题',
      required: ['level', 'method', 'why', 'target', 'topic', 'durationSeconds', 'durationText',
        'segments', 'encrypted', 'structure', 'caps', 'steps'],
      forbiddenStepKinds: COARSE_FORBIDDEN_STEPS,
      mustNot: ['cues', 'highlights', 'terms', 'outline', 'anchors', 'frames', 'bindings'],
      methodRequired: {},
      note: '不许解码、不许抽帧、不许起进程、不许读字幕正文'
    },
    detailed: {
      level: 'detailed',
      title: '详细档',
      what: '上面全部 + 逐段要点（带时间戳）+ 关键概念/术语 + 一图读懂用的层级结构；'
        + '走 ASR/多模态那几条路时，再追加"时间点锚点"（`anchors`，给按点抽帧用）'
        + '与"图文绑定"（`bindings`：每条知识点 ↔ 同期关键帧）',
      required: ['level', 'method', 'why', 'target', 'topic', 'durationSeconds', 'durationText',
        'segments', 'encrypted', 'structure', 'caps', 'steps',
        'cues', 'highlights', 'terms', 'outline', 'extractive'],
      forbiddenStepKinds: [],
      mustNot: [],
      /** 按 `summary.method` 追加的必备键（键不存在 ⇒ `missing`）。**只判"有没有"，不判质量**：
       *  "有键但内容为空"由合成那一侧挡住（`buildSummary` 的 `no-cues` / `no-content-reader`），
       *  与既有 `highlights` 的分工完全一致（见 `tests/video-summary.test.js` 的 E7/E9）。 */
      methodRequired: {
        // 字幕那一路也产出 anchors（它本来就有时间戳）—— 但不强制：字幕路的定义性产物是"逐句要点"
        'ffmpeg': ['anchors'],
        'hybrid': ['anchors'],
        'local-asr': ['anchors'],
        // omni 的卖点就是"知识点 ↔ 截图"：没有绑定就不算 omni（方案 A 做不到的正是这一条）
        'omni': ['anchors', 'bindings'],
        // mixed = 免费的时间戳文本 + 只花在总结/绑定上的多模态 token ⇒ 三件都得有
        'mixed': ['anchors', 'frames', 'bindings']
      },
      note: '需要内容源（字幕，或能解码且有人能读的音轨/画面）；没有内容源 ⇒ 响亮失败，绝不拿文件名硬凑'
    }
  };

  /**
   * **每条路的接口形状**（`docs/VIDEO-NOTES.md` §2 的机器可读那一半）：
   * `needs` = 它成立的能力前提（**全部**满足才成立）；`outputs` = 它**定义性**的产物
   * （与 `LEVEL_CONTRACT.detailed.methodRequired` 同义，两处必须一致 —— 测试逐条对拍）；
   * `steps` = 计划里会出现的步骤种类；`cost` = 代价的量级（一句话，成本表在文档里）。
   * ⚠️ 这里**不写选路规则**：谁被选中由 `selectMethod` 的唯一一套规则决定（见该函数头注），
   * 本表只描述"这条路长什么样"，绝不参与判定 —— 否则就有了第二份会漂的决策逻辑。
   */
  const PATH_SPECS = {
    'subtitle': {
      id: 'subtitle', title: '字幕路',
      needs: ['hasSubtitle'],
      inputs: ['.vtt', '.srt'],
      steps: ['read-playlist', 'read-subtitle', 'compose-detailed'],
      outputs: ['cues', 'highlights', 'terms', 'outline', 'anchors'],
      cost: '零成本（纯读文本）',
      what: '解析 `.vtt/.srt` → 带时间戳的 cue → 按停顿切段 → 逐段要点'
    },
    'local-asr': {
      id: 'local-asr', title: '本地 ASR 路',
      needs: ['hasFfmpeg', 'hasAsr'],
      inputs: ['音轨（16 kHz 单声道 wav）'],
      steps: ['read-playlist', 'decode', 'transcribe', 'compose-detailed'],
      outputs: ['cues', 'highlights', 'terms', 'outline', 'anchors'],
      cost: '一次付费为 0（自有 GPU / CPU 时间）',
      what: 'ffmpeg 抽音轨 → VAD 分段 → 本地 ASR（FunASR / faster-whisper / whisper.cpp）→ 句级 [start,end,text]'
    },
    'omni': {
      id: 'omni', title: '多模态 API 端到端路',
      needs: ['hasFfmpeg', 'hasVision'],
      inputs: ['10 分钟音频切片', '关键帧图片'],
      steps: ['read-playlist', 'decode', 'transcribe', 'frame', 'bind', 'compose-detailed'],
      outputs: ['cues', 'highlights', 'terms', 'outline', 'anchors', 'bindings'],
      cost: '按 token 计费；长音频最贵的一档',
      what: 'ffmpeg 按 10 分钟切片 → 多模态 API 一次给出转写 + 摘要 + 知识点↔截图绑定'
    },
    'mixed': {
      id: 'mixed', title: '折中路（推荐）',
      needs: ['hasFfmpeg', 'hasAsr', 'hasVision'],
      inputs: ['音轨（本地 ASR 用）', '关键帧图片（只送少量）'],
      steps: ['read-playlist', 'decode', 'transcribe', 'frame', 'bind', 'compose-detailed'],
      outputs: ['cues', 'highlights', 'terms', 'outline', 'anchors', 'frames', 'bindings'],
      cost: '本地 ASR 免费 + 只把总结/绑定花在 API 上 ⇒ 比全 API 低一个量级',
      what: 'local-asr 出时间戳文本 + 多模态 API 只做总结与图文绑定（不重复转写）'
    }
  };

  /** 字幕识别（摘要这一侧：**不认识 HLS 分片那套**，见文件头最后一段）。
   *  这是"字幕路"的入口判据，只在这里定义一次。 */
  const SUBTITLE_EXT = ['.vtt', '.srt'];

  /** 字幕解析/切段的常量（都在这里，别散落） */
  const GAP_SEC = 2.0;          // 停顿 ≥ 2 秒 = 换段（讲座换话题的常见停顿；同句内字幕间隔一般 < 1 秒）
  const MAX_SEG_SEC = 240;      // 单段最长 4 分钟（再长"逐段要点"就退化成"整段全抄"）
  const MAX_SEG_CUES = 120;     // 单段最多合并多少 cue（防止一条字幕轨 1000 行塞成一段）
  const MAX_HIGHLIGHT_CHARS = 200;
  const MAX_TITLE_CHARS = 28;

  /* ==========================================================================
   * 1. 小工具
   * ======================================================================== */

  /** 秒 → `mm:ss` / `h:mm:ss`。**唯一实现在 `src/doc-import.js` 的 `formatDuration`**
   *  （播放列表时长与字幕时间戳是同一种写法 ⇒ 抄一份就是第二份会漂的副本）。
   *  浏览器侧没加载 doc-import ⇒ **响亮抛错**，而不是自己拼一个"看着一样"的数字。 */
  function formatStamp(sec) {
    if (!docImport || typeof docImport.formatDuration !== 'function') {
      throw new Error('src/video-summary.js 需要 src/doc-import.js 导出的 formatDuration'
        + '（秒 → mm:ss 的唯一实现）—— 请先加载它');
    }
    return docImport.formatDuration(sec);
  }

  const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  const num = (x) => (typeof x === 'number' && isFinite(x) ? x : 0);
  const str = (x) => (x === undefined || x === null ? '' : String(x));

  /** 拒绝结果的**唯一**构造点：`{ok:false, code, message}` 形状一致 ⇒ 命令层只按 code/报文措辞 */
  function fail(code, message) {
    return { ok: false, code: code, message: message };
  }

  /* ==========================================================================
   * 2. 能力检测（纯：**只把探针给的读数归一成四个布尔**，不自己探）
   * ======================================================================== */

  /**
   * `probe`（探针读数）→ `{hasSubtitle, hasFfmpeg, hasAsr, hasVision}` + 人话读数。
   *
   * 四个布尔的**来源**（探针侧怎么探，见 `src/video-summary-probe.js`）：
   *   · `hasSubtitle` —— 目标里找到 `.vtt`/`.srt` 几份（**本机实测：真实课程目录 0 份**）；
   *   · `hasFfmpeg`   —— PATH 上有没有 `ffmpeg`（**本机实测：没有** ⇒ 这条路只能"规划"，跑不动）；
   *   · `hasAsr`      —— 有没有"音轨 → 带时间戳文本"的引擎（本批**未接**：只留接口位）；
   *   · `hasVision`   —— 有没有"帧 → 画面文字"的模型（本批**未接**：同上）。
   * 后两个**必须如实报 false**：它们决定 detailed 到底做不做得成，谎报一次就等于产出一份假摘要。
   *
   * @param {object} probe 探针读数（`{subtitles:[…], caps:{ffmpeg,asr,vision}, …}`），或已经归一过的 caps
   * @returns {{hasSubtitle:boolean, hasFfmpeg:boolean, hasAsr:boolean, hasVision:boolean,
   *            subtitleCount:number, subtitleFiles:string[], ffmpegPath:string|null,
   *            asrName:string|null, visionName:string|null, missing:string[]}}
   */
  function detectCapabilities(probe) {
    const p = isObj(probe) ? probe : {};
    const inner = isObj(p.caps) ? p.caps : {};
    /* 归一过的 caps 有**两个合法位置**：顶层（`detectCapabilities(caps)`）与 `caps` 键上
     * （`planStrategy({caps})` 的入参就长后者）。两处都认 —— 只认一处的话，
     * "注入一份 caps 说它有字幕"会被静默读成"什么都没有"，于是判据在**假的前提**上跑
     * （实测踩过：明明 2 份 `.vtt`，计划却说"没有字幕"，整条字幕路被自己的归一化吃掉）。
     * 形态判据：顶层或 `caps` 上有 `hasSubtitle` 布尔 ⇒ 那是**归一过的 caps**；否则是**探针原始读数**。 */
    const norm = (typeof p.hasSubtitle === 'boolean') ? p
      : ((typeof inner.hasSubtitle === 'boolean') ? inner : null);
    if (norm) {
      const out = {
        hasSubtitle: norm.hasSubtitle === true,
        hasFfmpeg: norm.hasFfmpeg === true,
        hasAsr: norm.hasAsr === true,
        hasVision: norm.hasVision === true,
        subtitleCount: num(norm.subtitleCount) || (Array.isArray(norm.subtitleFiles) ? norm.subtitleFiles.length : 0),
        subtitleFiles: Array.isArray(norm.subtitleFiles) ? norm.subtitleFiles.slice().sort() : [],
        ffmpegPath: typeof norm.ffmpegPath === 'string' && norm.ffmpegPath ? norm.ffmpegPath : null,
        asrName: norm.asrName ? str(norm.asrName) : null,
        visionName: norm.visionName ? str(norm.visionName) : null,
        missing: []
      };
      out.missing = missingLinesOf(out);
      return out;
    }
    // ---- 探针原始读数：字幕清单在 `subtitles` 上，引擎在 `caps` 上 ----
    const subs = Array.isArray(p.subtitles) ? p.subtitles : [];
    const ff = inner.ffmpeg || p.ffmpeg || null;
    const asr = inner.asr || p.asr || null;
    const vision = inner.vision || p.vision || null;
    const files = subs.map((s) => str(isObj(s) ? (s.rel || s.name) : s)).filter(Boolean).sort();
    const out = {
      hasSubtitle: subs.length > 0,
      hasFfmpeg: !!(ff && (ff.found === true || (typeof ff.path === 'string' && ff.path))),
      hasAsr: !!(asr && asr.available === true),
      hasVision: !!(vision && vision.available === true),
      subtitleCount: subs.length,
      subtitleFiles: files,
      ffmpegPath: (ff && typeof ff.path === 'string' && ff.path) ? ff.path : null,
      asrName: (asr && asr.name) ? str(asr.name) : null,
      visionName: (vision && vision.name) ? str(vision.name) : null,
      missing: []
    };
    out.missing = missingLinesOf(out);
    return out;
  }

  /** "缺什么"的**人话清单**（只在这里拼一次：命令层、拒绝报文、粗档说明都吃它）。
   *  ⚠️ 一条容易写错的判断：**没有 ffmpeg 时，ASR/视觉"装了也用不上"**（取不到音轨/帧）。
   *  这时如果只说"ASR 没接"，读者会以为"接上 ASR 就好了"—— 而真正的缺口是 ffmpeg。
   *  所以缺 ffmpeg 时对这两项**换一句说法**（不谎报"已接"，也不误报"没接"）。 */
  function missingLinesOf(caps) {
    const out = [];
    if (!caps.hasSubtitle) out.push('没有 .vtt/.srt 字幕');
    if (!caps.hasFfmpeg) out.push('本机没有 ffmpeg（PATH 上找不到 ⇒ 解码这一步跑不动）');
    if (!caps.hasFfmpeg && (caps.hasAsr || caps.hasVision)) {
      const has = [];
      if (caps.hasAsr) has.push('ASR');
      if (caps.hasVision) has.push('视觉模型');
      out.push(has.join(' 与 ') + ' 装了也取不到音轨/帧（同样卡在没有 ffmpeg）');
    } else {
      if (!caps.hasAsr) out.push('ASR（音轨 → 带时间戳的文字）没接');
      if (!caps.hasVision) out.push('视觉模型（读抽出来的帧）没接');
    }
    return out;
  }

  /** "现在可用的是哪条"——**拒绝报文里必须给这一句**（只说"不行"等于把人卡在原地） */
  function availableLine(caps) {
    const bits = [];
    if (caps.hasSubtitle) bits.push('subtitle（有 ' + caps.subtitleCount + ' 份字幕）');
    if (caps.hasFfmpeg) bits.push('ffmpeg（' + (caps.ffmpegPath || 'PATH 上找到了 ffmpeg') + '）');
    if (caps.hasSubtitle && caps.hasFfmpeg) bits.push('hybrid（两边都有）');
    if (caps.hasFfmpeg && caps.hasAsr) {
      bits.push('local-asr（本地 ASR：' + (caps.asrName || '已接') + '）');
    }
    if (caps.hasFfmpeg && !caps.hasAsr && caps.hasVision) {
      bits.push('omni（多模态 API 端到端：' + (caps.visionName || '已接') + '）');
    }
    if (caps.hasFfmpeg && caps.hasAsr && caps.hasVision) {
      bits.push('mixed（本地 ASR + 只把总结/图文绑定花在 API 上）');
    }
    bits.push('coarse（任何目录都能出：结构 + 时长 + 片数 + 加密 + 层级 + 一句话主题）');
    return bits.join(' / ');
  }

  /* ==========================================================================
   * 3. 选路（**自动检测的判据本体**；`planStrategy` 只调它，不另写一套）
   * ======================================================================== */

  /**
   * **证据句**（"凭什么这么判"那一半的人话）：字幕几份 / ffmpeg 在不在 / 读内容的引擎接没接。
   * 选路的 `why`、显式指定时的 `why`、拒绝报文里的"现在可用的是"都吃它 ⇒ **只有一处拼这句话**。
   */
  function evidenceLine(caps) {
    const sub = caps.hasSubtitle
      ? ('有 ' + num(caps.subtitleCount) + ' 份字幕'
        + (caps.subtitleFiles && caps.subtitleFiles.length
          ? '（' + caps.subtitleFiles.slice(0, 3).join('、') + (caps.subtitleFiles.length > 3 ? ' 等' : '') + '）'
          : ''))
      : '没有 .vtt/.srt 字幕';
    const ff = caps.hasFfmpeg
      ? ('本机有 ffmpeg（' + (caps.ffmpegPath || 'PATH 上找到了') + '）')
      : '本机没有 ffmpeg（PATH 上找不到）';
    const readers = [];
    if (caps.hasAsr) readers.push('ASR（' + (caps.asrName || '已接') + '）');
    if (caps.hasVision) readers.push('视觉模型（' + (caps.visionName || '已接') + '）');
    const tail = readers.length
      ? (' + 读内容的引擎：' + readers.join(' / ') + (caps.hasFfmpeg ? '' : '（但没 ffmpeg ⇒ 取不到音轨/帧）'))
      : '';
    return sub + ' + ' + ff + tail;
  }

  /**
   * **解码族内的具体一条**（不看字幕：那是 `selectMethod` 的事）。
   *
   * 判据（四条，顺序即优先级）：
   *   ① 没有 ffmpeg ⇒ 音轨/帧都取不到 ⇒ 只能报 `ffmpeg`（兜底格：连解码都要先说清做不到）；
   *   ② 有本地 ASR + 有多模态 ⇒ `mixed`（免费的时间戳文本 + 只把总结/绑定花在 API 上）；
   *   ③ 只有本地 ASR ⇒ `local-asr`；
   *   ④ 只有多模态 ⇒ `omni`（没有本地 ASR，只能让 API 端到端做）；
   *   ⑤ 都没有 ⇒ `ffmpeg`（兜底格：能解码、没谁读 ⇒ 详细档必红 `no-content-reader`）。
   *
   * @param {object} caps `detectCapabilities` 的产物
   * @returns {'mixed'|'local-asr'|'omni'|'ffmpeg'}
   */
  function decodePathOf(caps) {
    const c = isObj(caps) ? caps : {};
    if (c.hasFfmpeg !== true) return 'ffmpeg';
    if (c.hasAsr === true && c.hasVision === true) return 'mixed';
    if (c.hasAsr === true) return 'local-asr';
    if (c.hasVision === true) return 'omni';
    return 'ffmpeg';
  }

  /**
   * 四个布尔 → 一条路 + **一句人话 why**。
   *
   * 规则（**唯一一套**；`tests/video-summary.test.js` 的 B/J 组逐格穷举 16 格）：
   *   ① **没有 ffmpeg** ⇒ 音轨/帧都取不到（ASR/视觉"装了也用不上"）⇒ 只剩字幕轴：
   *      有字幕 ⇒ `subtitle`；没字幕 ⇒ `coarse-only`（并说清缺什么）。
   *   ② **有 ffmpeg + 有字幕** ⇒ `hybrid`（**字幕优先于 ASR**：字幕已是逐句带时间戳的文本，
   *      不用转写、没有 ASR 幻觉，而且免费、更快 —— 有字幕还去跑 ASR 是白花钱）。
   *      视觉模型没接时选路结论仍是 `hybrid`，**详细档时如实降级**到 `subtitle`（`degraded*` 三件）。
   *   ③ **有 ffmpeg + 没字幕** ⇒ 只能从音轨/画面来 ⇒ 交 `decodePathOf` 决出
   *      `mixed` / `local-asr` / `omni` / `ffmpeg` 兜底。
   *
   * `why` 的硬要求：**提到判据依据**（`judgeWhy` 机械核对）—— 用户问的是"凭什么选它"，
   * `why='hybrid'` 等于没说。
   *
   * @param {object} caps `detectCapabilities` 的产物
   * @returns {{method:string, why:string}}
   */
  function selectMethod(caps) {
    const c = isObj(caps) && typeof caps.hasSubtitle === 'boolean' ? caps : detectCapabilities(caps);
    const ev = evidenceLine(c);
    // ① 没有 ffmpeg：解码族的四条路**全部**不成立（ASR/视觉也救不了）
    if (!c.hasFfmpeg) {
      if (c.hasSubtitle) {
        return { method: 'subtitle', why: ev
          + ' ⇒ 选 subtitle：字幕本身就是逐句带时间戳的文本，够做详细档（不需要解码）' };
      }
      return { method: 'coarse-only', why: ev
        + ' ⇒ 只能粗档（结构 + 时长 + 片数 + 加密 + 课程/课时层级 + 一句话主题）；缺的是：'
        + missingLinesOf(c).join('、') };
    }
    // ② 有 ffmpeg + 有字幕：字幕优先（见函数头注的理由），视觉模型没接则在 detailed 时降级
    if (c.hasSubtitle) {
      return { method: 'hybrid', why: ev + ' ⇒ 选 hybrid：字幕给逐句（带时间戳）'
        + (c.hasVision ? '，抽帧补画面里的文字' : '，视觉模型没接 ⇒ 详细档时如实降级到 subtitle 那一路') };
    }
    // ③ 有 ffmpeg + 没字幕：只能从音轨/画面里来
    const path = decodePathOf(c);
    const whyTail = {
      'mixed': '选 mixed（折中）：本地 ASR 出免费的时间戳文本，多模态只做总结与图文绑定',
      'local-asr': '选 local-asr：有本地 ASR ⇒ 音轨转成带时间戳的句子，一次付费为 0',
      'omni': '选 omni：没有本地 ASR、但有多模态 ⇒ 切片让它端到端出转写+摘要+图文绑定（按 token 计费）',
      'ffmpeg': '选 ffmpeg：解码这一步可行，但**解出来没有谁能读**（ASR 与视觉模型都没接）⇒ 详细档会明确失败'
    }[path];
    return { method: path, why: ev + ' ⇒ ' + whyTail };
  }

  /* ==========================================================================
   * 4. 显式指定方法的拒绝（**绝不静默回退** —— 本批最重要的一条）
   * ======================================================================== */

  /**
   * 用户**明确**指定了方法时：能不能做？不能 ⇒ 返回拒绝（带"现在可用的是哪条"），
   * **不返回任何"替代方案"**（调用方不许拿它接着跑别的路）。
   *
   * 四种拒绝（各有独立 code，测试按 code 钉）：
   *   ① `coarse` + 显式方法 ⇒ `method-needs-detailed`（粗档不解码、不读字幕 ⇒ 方法在这一档没有落点；
   *      这里**响亮拒绝**而不是"收下但不用"—— 后者会让用户以为 ffmpeg/subtitle 真的跑过了）；
   *   ② `subtitle` 但没字幕 ⇒ `method-unavailable`；
   *   ③ `ffmpeg` 但没 ffmpeg ⇒ `method-unavailable`（报文里给出"装 ffmpeg 或用 subtitle/hybrid"）；
   *   ④ `hybrid` 缺任何一边 ⇒ `hybrid-needs-both`（缺哪边就点哪边）。
   *
   * ⚠️ 本批（2026-10-55）**没有**给新三条路（`local-asr`/`omni`/`mixed`）开 `--method` 取值：
   * 它们是**选路结论**，所以这里自然也不会有"显式指定 local-asr"的分支 —— 真点了会先在
   * `planStrategy` 的 `bad-method` 处被拒（报文只列四个真取值）。`ffmpeg` 这一族仍然守在这里：
   * **缺 ffmpeg / 没人读**这两条闸对整族生效（族内细化在 `via` 里，见 `decodePathOf`）。
   */
  function explicitRefusal(method, caps, level) {
    // `auto` **不是**显式指定 ⇒ 它没有"回退"可言（回退这个词只对用户点名的那一条成立）。
    // ⚠️ 这条守在最前面：`planStrategy` 任何路径调进来都安全，不靠调用方记得"别拿 auto 来问"。
    if (method === 'auto') return null;
    if (level === 'coarse') {
      return {
        code: CODES.METHOD_NEEDS_DETAILED,
        message: '`--method ' + method + '` 只在 `--level detailed` 生效：粗档的契约是'
          + '"结构 + 时长 + 片数 + 加密 + 课程/课时层级 + 一句话主题"，**不解码、也不读字幕正文**'
          + ' ⇒ 收下方法却什么也不做，等于让你以为 ' + method + ' 跑过了。'
          + '要它生效：加 `--level detailed`；只要粗档：去掉 `--method`。'
          + '（这个目录现在可用的是：' + availableLine(caps) + '）'
      };
    }
    if (method === 'subtitle' && !caps.hasSubtitle) {
      return {
        code: CODES.METHOD_UNAVAILABLE,
        message: '`--method subtitle` 做不到：这个目录里**没有 .vtt/.srt 字幕**。'
          + '**不会退回别的路**（你明确指定了方法，回退等于骗你）。'
          + '现在可用的是：' + availableLine(caps)
      };
    }
    if (method === 'ffmpeg' && !caps.hasFfmpeg) {
      return {
        code: CODES.METHOD_UNAVAILABLE,
        message: '`--method ffmpeg` 做不到：本机**没有 ffmpeg**（PATH 上找不到 `ffmpeg`/`ffprobe`）。'
          + '**不会退回别的路**（你明确指定了方法）。三条出路：① 装 ffmpeg 后重跑这条；'
          + '② 有字幕就用 `--method subtitle`；③ 用 `--method auto` 让它自己挑。'
          + '现在可用的是：' + availableLine(caps)
      };
    }
    if (method === 'ffmpeg' && caps.hasFfmpeg && !caps.hasAsr && !caps.hasVision) {
      return {
        code: CODES.NO_CONTENT_READER,
        message: '有 ffmpeg，但**解出来的东西没有谁能读**：ASR（音轨 → 文字）没接、'
          + '视觉模型（读帧）也没接 ⇒ 详细档要的"逐段要点（带时间戳）"取不到。'
          + '**不拿文件名硬凑**。要粗档：`--level coarse`（结构 + 时长 + 片数 + 加密 + 层级）。'
      };
    }
    if (method === 'hybrid') {
      const lack = [];
      if (!caps.hasSubtitle) lack.push('字幕（这个目录里没有 .vtt/.srt）');
      if (!caps.hasFfmpeg) lack.push('ffmpeg（本机 PATH 上找不到）');
      if (lack.length) {
        return {
          code: CODES.HYBRID_NEEDS_BOTH,
          message: '`--method hybrid` 是**两条路拼起来的**，缺一边就拼不成：缺 '
            + lack.join('、') + '。**不会退回别的路**（你明确指定了方法）。'
            + '现在可用的是：' + availableLine(caps)
        };
      }
    }
    return null;
  }

  /* ==========================================================================
   * 5. 计划（**唯一对外决策入口**）
   * ======================================================================== */

  /** 计划步骤的构造点（kind 只许取 `STEP_KINDS` 里的值） */
  function step(kind, what, extra) {
    if (STEP_KINDS.indexOf(kind) < 0) throw new Error('未知的步骤种类: ' + kind);
    return Object.assign({ kind: kind, what: what }, extra || {});
  }

  /** 计划里的步骤是否**碰了内容**（解码 / 抽帧 / 转写）—— 粗档必须为 false，由 `checkSummary` 复核 */
  function decodesOf(steps) {
    return (steps || []).some((s) => ['decode', 'frame', 'transcribe'].indexOf(s && s.kind) >= 0);
  }

  /**
   * **选路 + 档位 ⇒ 一份可执行的计划**。这是本模块对外的唯一决策入口：
   * 调用方（命令层 / MCP）只读它的 `ok/method/level/why/steps/degraded`，**不许自己再判一次**。
   *
   * 返回 `{ok:true}` 的形状：
   *   `{ok, code:'ok', method, level, why, steps[], caps, decodes, degraded, degradedFrom?, degradedTo?, degradedWhy?}`
   *   · `method` = **选路结论**（`hybrid|ffmpeg|subtitle|local-asr|omni|mixed|coarse-only`）——
   *     与档位无关，它答的是"这段视频**能用什么方法**"（用户要的自动检测结论就在这里）；
   *   · `via`    = **解码族内的具体一条**（`local-asr`/`omni`/`mixed`/`ffmpeg` 兜底），
   *     只在 detailed 且走解码族时非空；`subtitle`/`hybrid` 恒为 `null`。
   *     显式 `--method ffmpeg` 时它答的是"你点的这一族里落哪一条"—— **族内细化，不是换路**；
   *   · `steps`  = **这一档实际会做的活**。粗档恒为 `read-playlist → compose-coarse`
   *     （`method` 仍如实报 `hybrid` 之类也没关系：`why` 会明说"粗档不解码，选路是 detailed 时会走哪条"，
   *     而 `decodes:false` 是机器可读的同一句话）；
   *   · `degraded` = 只在 hybrid 且视觉模型没接时出现（如实降级到 `subtitle`，并带 `degradedFrom`）。
   *
   * @param {object} facts 探针读数（至少含 `caps` 或四个布尔；`planStrategy` 不碰盘）
   * @param {{method?:string, level?:string}} [opts]
   */
  function planStrategy(facts, opts) {
    const f = isObj(facts) ? facts : {};
    const o = isObj(opts) ? opts : {};
    /* ⚠️ 必须把**整份**探针读数交给 `detectCapabilities`：字幕清单在 `facts.subtitles` 上，
     * 而 ffmpeg/ASR/视觉在 `facts.caps` 上 —— 只喂 `facts.caps` 会让"有字幕"永远读成 false
     * （实测踩过：探针明明找到 2 份 `.vtt`，计划却说"没有字幕"）。 */
    const caps = detectCapabilities(f);
    const level = (o.level === undefined || o.level === null || o.level === '') ? DEFAULT_LEVEL : str(o.level);
    const method = (o.method === undefined || o.method === null || o.method === '') ? DEFAULT_METHOD : str(o.method);

    if (LEVELS.indexOf(level) < 0) {
      return fail(CODES.BAD_LEVEL, '`--level` 只认 ' + LEVELS.join(' / ') + '，收到 '
        + JSON.stringify(level) + '（两档的含义见 `--help`：coarse = 结构 + 时长；'
        + 'detailed = 再加逐段要点 + 术语 + 层级）');
    }
    if (METHODS.indexOf(method) < 0) {
      return fail(CODES.BAD_METHOD, '`--method` 只认 ' + METHODS.join(' / ') + '，收到 '
        + JSON.stringify(method) + '（auto = 自动检测并说明为什么；其余三条是显式指定，'
        + '不可用时**不会**退回别的路）');
    }

    const sel = selectMethod(caps);
    // ---- ① 显式指定：先判"能不能做"，不能就响亮拒绝（**绝不静默回退**）----
    const refusal = explicitRefusal(method, caps, level);
    if (refusal) return fail(refusal.code, refusal.message);
    const effective = method === 'auto' ? sel.method : method;

    // ---- ② 自动档在 detailed 下的可行性（"做不到"必须是明确结果，不是抛错，也不是硬凑）----
    if (level === 'detailed') {
      if (effective === 'coarse-only') {
        return fail(CODES.NO_CONTENT_SOURCE,
          '**详细档做不到**：' + sel.why + '。逐段要点要内容源（字幕，或能解码且有人能读的音轨/画面），'
          + '而这个目录两样都没有 ⇒ **不拿文件名/目录名拼一份"详细摘要"**（那看着像成功能，其实是假绿）。'
          + '要现在就能出的结果：`--level coarse`（结构 + 时长 + 片数 + 加密 + 课程/课时层级 + 一句话主题）。');
      }
      if (effective === 'ffmpeg' && !caps.hasAsr && !caps.hasVision) {
        return fail(CODES.NO_CONTENT_READER,
          '**详细档做不到**：' + sel.why + '。但**解出来的东西没有谁能读** —— ASR 与视觉模型都没接 '
          + '⇒ 逐段要点取不到，**不拿文件名硬凑**。要粗档：`--level coarse`。');
      }
    }

    // ---- ③ 该档实际做什么（粗档恒不解码）----
    const topic = str(f.topic) || '(未命名)';
    /* `why` 的**证据那一半**：auto 用选路结论；显式指定就用"你指定的那条 + 它可用的依据"。
     * ⚠️ 这里是"没有静默换路"的**报告面**：`plan.method` 必须是 effective（用户点的那条），
     * 不能报成自动检测的结论 —— 否则用户读到的是一条**他没选的路**（实测被 C7 的穷举判据抓住）。 */
    const whyBase = (method === 'auto')
      ? sel.why
      : ('**显式指定 ' + method + '**：' + evidenceLine(caps) + ' ⇒ 按 ' + method + ' 走（**不换路**）');
    if (level === 'coarse') {
      const why = whyBase + '｜本档是 coarse：**不解码、不读字幕、不起任何进程**，'
        + '只出结构 + 时长 + 片数 + 加密 + 课程/课时层级 + 一句话主题'
        + (effective === 'coarse-only' ? '' : '（上面的选路是"要做 detailed 时会走哪条"）');
      return {
        ok: true, code: 'ok', level: level, method: effective, via: null, why: why, caps: caps, decodes: false,
        degraded: false, selection: { method: sel.method, why: sel.why },
        steps: [
          step('read-playlist', '读播放列表（**只读文本**：`#EXTINF` 求和得时长、数分片、看是否带 EXT-X-KEY）',
            { target: str(f.target) || null }),
          step('compose-coarse', '合成粗档：结构 + 时长 + 片数 + 加密 + 课程/课时层级 + 一句话主题',
            { topic: topic })
        ]
      };
    }

    // ---- ④ detailed：按选路拼步骤（hybrid 的"视觉模型没接"⇒ 如实降级到 subtitle）----
    const steps = [step('read-playlist', '读播放列表（时长/片数/是否加密 —— 与两条路共用的那一份事实）',
      { target: str(f.target) || null })];
    let degraded = false, degradedFrom = null, degradedTo = null, degradedWhy = null;
    let why = whyBase;
    /* `via` = **解码族内的具体一条**（`local-asr`/`omni`/`mixed`/`ffmpeg` 兜底）。
     * 显式 `--method ffmpeg` 时它答的是"你点的这一族里，按现在的能力会落哪一条" —— 这是
     * **族内细化**，不是换路（点解码族就绝不会跑到字幕族）。字幕/hybrid 那两条没有 `via`。 */
    let via = null;

    if (effective === 'subtitle') {
      steps.push(step('read-subtitle', '读字幕（.vtt/.srt）并解析成带时间戳的 cue'));
      steps.push(step('compose-detailed', '按停顿切段 → 逐段要点 + 重复出现的术语 + 一图读懂的层级'));
    } else if (effective === 'local-asr') {
      via = 'local-asr';
      steps.push(step('decode', 'ffmpeg 抽音轨：`-vn -ac ' + ASR_AUDIO.channels + ' -ar ' + ASR_AUDIO.sampleRate
        + '`（语音识别的标准输入形状）', { via: 'ffmpeg', audio: 'pcm-16k-mono' }));
      steps.push(step('transcribe', '本地 ASR（' + (caps.asrName || 'ASR') + '）：VAD 分段（每段 '
        + VAD_SEGMENT_SEC.min + '~' + VAD_SEGMENT_SEC.max + ' 秒）→ 句级 [start,end,text]'));
      steps.push(step('compose-detailed', '把带时间戳的句子按停顿切段 → 逐段要点 + 时间点锚点 + 关键概念'));
    } else if (effective === 'omni') {
      via = 'omni';
      steps.push(step('decode', 'ffmpeg 按 ' + Math.round(OMNI_SLICE_SEC / 60) + ' 分钟切片（多模态 API 的单次输入上限）',
        { via: 'ffmpeg', sliceSec: OMNI_SLICE_SEC }));
      steps.push(step('transcribe', '多模态 API（' + (caps.visionName || 'omni') + '）端到端：转写 + 摘要一步出'));
      steps.push(step('frame', 'ffmpeg 按知识点时间点抽关键帧（`-ss` 定位，不是均匀抽帧）', { align: 'anchor' }));
      steps.push(step('bind', '把每条知识点与同期关键帧配对（知识点 ↔ 幻灯片截图）'));
      steps.push(step('compose-detailed', '合成：逐段要点（带时间戳）+ 图文绑定 + 术语 + 层级'));
    } else if (effective === 'mixed') {
      via = 'mixed';
      steps.push(step('decode', 'ffmpeg 抽音轨：`-vn -ac ' + ASR_AUDIO.channels + ' -ar ' + ASR_AUDIO.sampleRate
        + '`', { via: 'ffmpeg', audio: 'pcm-16k-mono' }));
      steps.push(step('transcribe', '本地 ASR（' + (caps.asrName || 'ASR') + '）出句级时间戳（**免费的那一半**）'));
      steps.push(step('frame', 'ffmpeg 按知识点时间点抽关键帧（只抽少量，送给 API）', { align: 'anchor' }));
      steps.push(step('bind', '多模态 API（' + (caps.visionName || 'omni')
        + '）**只做**总结与图文绑定（不重复转写）'));
      steps.push(step('compose-detailed', '合成：逐段要点（带时间戳）+ 图文绑定 + 术语 + 层级'));
    } else if (effective === 'ffmpeg') {
      /* 解码族的**兜底格**：能解码，但没有谁读（ASR/视觉都没接）。detailed 上面那道闸已经
       * 拒过一遍；走到这里说明是显式 `--method ffmpeg` 且至少有一个读引擎 —— 这时按"有什么读什么"拼。 */
      via = decodePathOf(caps);
      steps.push(step('decode', 'ffmpeg 解码：抽音轨（' + (caps.asrName || 'ASR') + '）'
        + (caps.hasVision ? ' / 抽帧（' + caps.visionName + '）' : ''), { via: 'ffmpeg' }));
      if (caps.hasAsr) steps.push(step('transcribe', '把音轨转成带时间戳的文字（ASR）'));
      if (caps.hasVision) steps.push(step('frame', '按知识点时间点抽帧（有锚点时按锚点，否则按固定间隔）',
        { align: 'anchor-or-interval' }));
      steps.push(step('compose-detailed', '把转写/画面文字切段 → 逐段要点 + 术语 + 层级'));
    } else if (effective === 'hybrid') {
      steps.push(step('read-subtitle', '读字幕（.vtt/.srt）并解析成带时间戳的 cue（逐句那一路）'));
      if (caps.hasVision) {
        steps.push(step('decode', 'ffmpeg 解码（只为抽帧）', { via: 'ffmpeg' }));
        steps.push(step('frame', '按知识点时间点抽帧（有锚点时按锚点），交给视觉模型补画面里的字',
          { align: 'anchor-or-interval' }));
      } else {
        // **如实降级**：hybrid 的"抽帧补画面"那半段没有读帧的模型 ⇒ 只走字幕那一路。
        degraded = true; degradedFrom = 'hybrid'; degradedTo = 'subtitle';
        degradedWhy = '两边都有，但**视觉模型没接** ⇒ hybrid 的"抽帧补画面文字"那半段做不了，'
          + '本次只走字幕那一路（逐句时间戳仍是真的，画面里的字**没有**补进来）';
        why = whyBase + '｜**降级**：' + degradedWhy;
      }
      steps.push(step('compose-detailed', '把字幕（+ 画面文字）切段 → 逐段要点 + 术语 + 层级'));
    }

    return {
      ok: true, code: 'ok', level: level, method: effective, via: via, why: why, caps: caps,
      steps: steps, decodes: decodesOf(steps),
      degraded: degraded, degradedFrom: degradedFrom, degradedTo: degradedTo, degradedWhy: degradedWhy,
      selection: { method: sel.method, why: sel.why }
    };
  }

  /* ==========================================================================
   * 6. 档位契约（对外可查 + 可机械核对）
   * ======================================================================== */

  /** 某一档"必须产出什么 / 不许做什么"（返回**副本**：调用方改不动本文件的表）。 */
  function summarizeContract(level) {
    const c = LEVEL_CONTRACT[str(level)];
    if (!c) return null;
    const mr = {};
    Object.keys(c.methodRequired || {}).forEach((k) => { mr[k] = c.methodRequired[k].slice(); });
    return {
      level: c.level, title: c.title, what: c.what,
      required: c.required.slice(), forbiddenStepKinds: c.forbiddenStepKinds.slice(),
      mustNot: c.mustNot.slice(), methodRequired: mr, note: c.note
    };
  }

  /** 某一档 + 某条路的**必备键全集**（档位基础必备 ∪ `methodRequired[method]`）。
   *  只有一处拼它 ⇒ `checkSummary` 与命令层/文档不会各写一份"到底要交什么"。 */
  function requiredKeysOf(level, method) {
    const c = summarizeContract(level);
    if (!c) return [];
    const extra = (method && c.methodRequired[method]) ? c.methodRequired[method] : [];
    const out = c.required.slice();
    extra.forEach((k) => { if (out.indexOf(k) < 0) out.push(k); });
    return out;
  }

  /** `why` 的机械判据：非空、够长、**提到判据依据**（为什么选它 / 缺什么） */
  function judgeWhy(why) {
    const s = str(why).trim();
    if (!s) return { ok: false, reason: '空' };
    if (s.length < WHY_MIN_CHARS) return { ok: false, reason: '太短（' + s.length + ' 字）' };
    const hit = WHY_EVIDENCE_WORDS.filter((w) => s.indexOf(w) >= 0);
    if (!hit.length) return { ok: false, reason: '没有提到判据依据（要说清是"有字幕/有 ffmpeg/缺什么"这类事实）' };
    return { ok: true, reason: '', evidence: hit };
  }

  /**
   * 产出**是否满足档位契约**（结构判据）。
   *
   * 这是"detailed 不硬凑"与"coarse 不许偷偷解码"的机械那一半：
   *   · 缺任何一个 `required` 键 ⇒ `missing`（detailed 少了 `highlights` = 它没真做详细档）；
   *   · 粗档的 steps 里出现 `decode`/`frame`/`transcribe`/`spawn` ⇒ `violations`；
   *   · 粗档出现 `cues`/`highlights`/`terms`/`outline` ⇒ `violations`（那是详细档的产物）；
   *   · `why` 不满足 `judgeWhy` ⇒ `violations`。
   */
  function checkSummary(summary, level) {
    const c = summarizeContract(level);
    const s = isObj(summary) ? summary : {};
    const out = { ok: false, level: c ? c.level : null, missing: [], violations: [], required: c ? c.required.slice() : [] };
    if (!c) { out.violations.push('未知档位: ' + JSON.stringify(level)); return out; }
    /* 必备键 = 档位基础必备 ∪ 该路的追加必备（`methodRequired[summary.method]`）。
     * ⚠️ 用 `requiredKeysOf` 而不是自己拼：拼第二次就是第二份会漂的契约。 */
    const need = requiredKeysOf(level, str(s.method));
    out.required = need;
    need.forEach((k) => {
      if (s[k] === undefined || s[k] === null) out.missing.push(k);
    });
    const steps = Array.isArray(s.steps) ? s.steps : [];
    steps.forEach((st) => {
      const kind = st && st.kind;
      if (c.forbiddenStepKinds.indexOf(kind) >= 0) {
        out.violations.push('steps 里出现了 `' + kind + '` —— ' + c.title + '的契约禁止：' + c.note);
      }
      if (STEP_KINDS.indexOf(kind) < 0) out.violations.push('steps 里出现未知步骤种类 `' + kind + '`');
    });
    c.mustNot.forEach((k) => {
      const v = s[k];
      if (v !== undefined && !(Array.isArray(v) && v.length === 0)) {
        out.violations.push('不该产出 `' + k + '`（那是详细档的东西）');
      }
    });
    const w = judgeWhy(s.why);
    if (!w.ok) out.violations.push('why ' + w.reason + '（必须说清"凭什么选它/缺什么"）');
    ['durationSeconds', 'segments'].forEach((k) => {
      if (s[k] !== undefined && typeof s[k] !== 'number') out.violations.push('`' + k + '` 必须是数字');
    });
    if (s.encrypted !== undefined && typeof s.encrypted !== 'boolean') out.violations.push('`encrypted` 必须是布尔');
    if (s.structure !== undefined && !Array.isArray(s.structure)) out.violations.push('`structure` 必须是数组');
    if (s.extractive !== undefined && s.level === 'detailed' && s.extractive !== true) {
      out.violations.push('详细档的要点必须是**抽取式**（`extractive:true`）—— 本工程没有生成式摘要，不许假装有');
    }
    out.ok = out.missing.length === 0 && out.violations.length === 0;
    return out;
  }

  /* ==========================================================================
   * 7. 字幕解析（.vtt / .srt —— **纯文本**，当前就能真做的那一条路）
   * ======================================================================== */

  /** 按扩展名认字幕（摘要这一侧的判据，见文件头最后一段；不认识 HLS 分片那套） */
  function isSubtitleName(name) {
    const s = str(name).toLowerCase();
    return SUBTITLE_EXT.indexOf(s.slice(s.lastIndexOf('.'))) >= 0;
  }

  /** 字幕文本 → `'vtt' | 'srt' | 'unknown'`（只按**形态**判，不看扩展名：扩展名可以骗人） */
  function detectSubtitleKind(text) {
    const s = str(text).replace(/^\uFEFF/, '');
    if (/^\s*WEBVTT\b/i.test(s)) return 'vtt';
    if (/\d{1,2}:\d{2}:\d{2},\d{1,3}\s*-->/.test(s)) return 'srt';
    if (/\d{1,2}:\d{2}(:\d{2})?[.,]\d{1,3}\s*-->/.test(s)) return 'vtt';
    return 'unknown';
  }

  /** `HH:MM:SS,mmm` / `MM:SS.mmm` / `SS.mmm` → 秒（毫秒精度取整到 3 位，避免浮点噪声） */
  function parseStamp(raw) {
    const s = str(raw).trim().replace(',', '.');
    const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(s)
      || /^(\d{1,2})(?:\.(\d{1,3}))?$/.exec(s);
    if (!m) return null;
    let h = 0, mi = 0, sec = 0, ms = 0;
    if (m.length >= 4) {
      h = m[1] === undefined ? 0 : parseInt(m[1], 10);
      mi = parseInt(m[2], 10); sec = parseInt(m[3], 10);
      ms = m[4] === undefined ? 0 : parseInt((m[4] + '00').slice(0, 3), 10);
    } else {
      sec = parseInt(m[1], 10);
      ms = m[2] === undefined ? 0 : parseInt((m[2] + '00').slice(0, 3), 10);
    }
    if (!isFinite(h) || !isFinite(mi) || !isFinite(sec) || mi > 59 || sec > 59) return null;
    return Math.round((h * 3600 + mi * 60 + sec + ms / 1000) * 1000) / 1000;
  }

  /** 一行 cue 文本的清洗：去标签（`<v 张三>` / `<i>` / `{\an8}`）、还原常见实体、压空白 */
  function cleanCueText(raw) {
    return str(raw)
      .replace(/\{\\[^}]*\}/g, '')            // ASS/SSA 风格 {\an8}
      .replace(/<[^<>]*>/g, '')               // VTT 的内联标签（<v 说话人> <c.cls> <i> …）
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
      .replace(/[ \t\u00a0]+/g, ' ')
      .trim();
  }

  /**
   * 解析字幕文本 → **带时间戳的 cue 列表**（纯函数；`tests/video-summary.test.js` 的 A 组钉死）。
   *
   * 该绿：`WEBVTT` 头 + 两段带 `-->` 的正文 ⇒ 2 条 cue，各自带 start/end/text。
   * 该红（各自注入）：把 `WEBVTT` 头当正文（判据：cue 文本里绝不含 `WEBVTT`）；
   *  `NOTE` / `STYLE` / `REGION` 块被当台词（判据：这些块的内容一条都不进 cues）。
   *
   * 诚实边界：**解析不了的行不静默丢** —— 进 `warnings`（带行号与原文），由命令层印出来。
   *
   * @param {string} text 字幕原文
   * @param {{src?:string}} [opts] `src` 只用于把 cue 归属回来源文件（不进判据）
   * @returns {{ok:boolean, kind:string, cues:Array, warnings:Array, reason?:string}}
   */
  function parseSubtitle(text, opts) {
    const o = isObj(opts) ? opts : {};
    const raw = str(text).replace(/^\uFEFF/, '');
    if (!raw.trim()) {
      return { ok: false, kind: 'unknown', cues: [], warnings: [], reason: '空文件（0 字节或只有空白）' };
    }
    const kind = detectSubtitleKind(raw);
    const lines = raw.split(/\r?\n/);
    const cues = [], warnings = [];
    let block = [], blockStart = 0;

    const flush = () => {
      if (!block.length) return;
      const cur = block, atLine = blockStart;
      block = [];
      const head = cur[0] === undefined ? '' : cur[0];
      // `WEBVTT` 是**文件头**（可能带 `Kind: captions` 之类），不是台词 —— 它单独成块时直接吃掉，
      // 既不算 cue、也**不报**"解析不了"（否则每份正常 vtt 都会多一条假警告）。
      if (/^\s*WEBVTT\b/i.test(head)) return;
      const skipWord = /^(NOTE|STYLE|REGION)\b/i.test(head.trim());
      if (skipWord) return;                          // 注释/样式/区域块：**不是台词**（本判据的主要坑）
      // 找时间轴行：第一行或第二行（第二行 = 有 cue id 的写法）
      let ti = -1;
      for (let i = 0; i < cur.length && i < 2; i++) { if (cur[i].indexOf('-->') >= 0) { ti = i; break; } }
      if (ti < 0) {
        if (cur.join('').trim()) {
          warnings.push({ kind: 'no-timing', line: atLine + 1, raw: head.trim().slice(0, 80) });
        }
        return;
      }
      const parts = cur[ti].split('-->');
      const start = parseStamp(parts[0]);
      // 结束时刻：取第二个时间的**第一个 token**（后面可能是 VTT 的 cue settings：align:start position:10%）
      const endTok = str(parts[1]).trim().split(/\s+/)[0];
      const end = parseStamp(endTok);
      if (start === null || end === null) {
        warnings.push({ kind: 'bad-timing', line: atLine + ti + 1, raw: cur[ti].trim().slice(0, 80) });
        return;
      }
      const body = cur.slice(ti + 1).map(cleanCueText).filter(Boolean);
      if (!body.length) {
        warnings.push({ kind: 'empty-text', line: atLine + ti + 1, raw: cur[ti].trim().slice(0, 80) });
        return;
      }
      cues.push({
        start: start, end: end < start ? start : end,
        text: body.join(' ').replace(/\s+/g, ' ').trim(),
        src: o.src ? str(o.src) : null,
        at: formatStamp(start)
      });
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) { flush(); continue; }
      if (!block.length) blockStart = i;
      block.push(line);
    }
    flush();
    if (!cues.length) {
      return { ok: false, kind: kind, cues: [], warnings: warnings,
        reason: '一个 cue 都解析不出来（' + (kind === 'unknown' ? '既不像 .vtt 也不像 .srt' : '时间轴行都坏了')
          + '）—— 这份文件**没有**被当正文硬算' };
    }
    return { ok: true, kind: kind, cues: cues, warnings: warnings };
  }

  /* ==========================================================================
   * 8. 详细档的合成（**抽取式**：本工程没有生成式摘要，不许假装有）
   * ======================================================================== */

  const CJK_STOP = ['我们', '你们', '他们', '这个', '那个', '这些', '那些', '一个', '什么', '怎么',
    '就是', '可以', '没有', '这样', '那样', '因为', '所以', '但是', '如果', '然后', '现在', '大家',
    '一下', '时候', '已经', '还是', '不是', '这里', '那里', '其实', '可能', '需要', '觉得', '知道',
    '东西', '事情', '部分', '上面', '下面', '前面', '后面', '之后', '之前', '这种', '那种', '一种'];
  const LATIN_STOP = ['the', 'and', 'for', 'with', 'you', 'that', 'this', 'are', 'but', 'not', 'can',
    'will', 'have', 'from', 'they', 'what', 'when', 'your', 'our', 'his', 'her', 'its', 'was', 'were',
    'has', 'been', 'all', 'one', 'two', 'how', 'why', 'who', 'then', 'than', 'there', 'their'];
  /** 以这些**虚字**开头或结尾的片段不当术语（"的召回"这种跨词片段是 n-gram 的已知噪声） */
  const GRAM_EDGE_STOP = ['的', '了', '是', '在', '和', '与', '就', '也', '都', '很', '把', '被',
    '让', '给', '对', '从', '到', '而', '并', '或', '及', '着', '过', '我', '你', '他', '她', '它',
    '这', '那', '有', '不', '会', '要', '说', '看', '做', '个', '些', '么', '吧', '呢', '啊', '里',
    '上', '下', '中', '后', '前', '时'];

  const isCJK = (ch) => /[\u4e00-\u9fff]/.test(ch);
  const isAsciiWordChar = (ch) => /[A-Za-z0-9]/.test(ch);

  /** 把多行字幕拼成一句：**CJK 之间不插空格**，ASCII 词之间插一个空格（中文讲座里这两种都常见） */
  function joinCueText(parts) {
    const arr = (parts || []).map((s) => str(s).trim()).filter(Boolean);
    let out = '';
    arr.forEach((p) => {
      if (!out) { out = p; return; }
      const a = out.charAt(out.length - 1), b = p.charAt(0);
      out += (isAsciiWordChar(a) && isAsciiWordChar(b)) ? ' ' + p : p;
    });
    return out;
  }

  /**
   * 按**停顿**把 cue 切成段（"逐段要点"的单位）。
   * 判据：与上一 cue 的间隔 ≥ `GAP_SEC`，或本段已超 `MAX_SEG_SEC` / `MAX_SEG_CUES` ⇒ 换段。
   * 为什么要判停顿而不是"每 N 条切一刀"：讲座的段落边界就是停顿，按条数切会把一句话劈成两段，
   * 于是"逐段要点"变成"逐句复述"（那不是要点）。
   */
  function chunkCues(cues, opts) {
    const o = isObj(opts) ? opts : {};
    const gap = typeof o.gapSec === 'number' ? o.gapSec : GAP_SEC;
    const maxSec = typeof o.maxSegSec === 'number' ? o.maxSegSec : MAX_SEG_SEC;
    const maxCues = typeof o.maxSegCues === 'number' ? o.maxSegCues : MAX_SEG_CUES;
    const list = (Array.isArray(cues) ? cues : []).slice()
      .sort((a, b) => (num(a.start) - num(b.start)) || (num(a.end) - num(b.end)));
    const segs = [];
    let cur = null;
    list.forEach((c) => {
      const start = num(c.start), end = num(c.end);
      const needNew = !cur || (start - cur.end >= gap) || (end - cur.start > maxSec) || (cur.cues.length >= maxCues);
      if (needNew) {
        cur = { start: start, end: end, cues: [] };
        segs.push(cur);
      }
      cur.end = Math.max(cur.end, end);
      cur.cues.push(c);
    });
    return segs.map((s, i) => ({
      index: i + 1,
      start: s.start,
      end: s.end,
      at: formatStamp(s.start),
      atEnd: formatStamp(s.end),
      cueCount: s.cues.length,
      text: joinCueText(s.cues.map((c) => c.text))
    }));
  }

  /** 取第一句（要点那一行用它）：截到句末标点，过长再截到 `max` 字并加省略号。
   *  ⚠️ **冒号不算句末**：中文讲座里"第二句：RAG 的召回率…"的冒号是**引出**，
   *  在冒号处截断会让标题剩下一句空话（实测踩过：三条要点全变成"第一句/第二句/第三句"）。 */
  function firstSentence(text, max) {
    const s = str(text).replace(/\s+/g, ' ').trim();
    if (!s) return '';
    const limit = typeof max === 'number' ? max : MAX_TITLE_CHARS;
    const m = /^[^。！？!?；;]*[。！？!?；;]?/.exec(s);
    let head = (m ? m[0] : s).trim();
    if (!head) head = s;
    if (head.length > limit) head = head.slice(0, limit) + '…';
    return head;
  }

  /**
   * 关键概念/术语（**抽取式**：只报"反复出现的片段"，不判语义）。
   * 口径（写死在这里，注释即判据）：
   *   · 拉丁词/缩写：长度 ≥ 2 的词（`RAG` / `LLM` / `KPI` / `PMF` 这类在本机课程里真的出现过）；
   *   · 中文：2–4 字的 n-gram；
   *   · **只保留出现在 ≥ 2 个段里的**（"反复说"才算关键词；只出现一次的是噪声）；
   *   · 去掉高频虚词（`CJK_STOP` / `LATIN_STOP` —— 有意最小，不追全量停用词表）；
   *   · 长的片段吃掉它自己的子片段（同一 segCount 时只留最长的那个）；
   *   · 排序 = (段数降序, 长度降序, 码点升序) ⇒ **两跑逐字节相同**。
   * ⚠️ 能力边界：它答的是"这份字幕反复说哪些词"，**不是**"术语表"（没有词表、没有模型）。
   */
  function keyTerms(segments, opts) {
    const o = isObj(opts) ? opts : {};
    const minSegs = typeof o.minSegs === 'number' ? o.minSegs : 2;
    const limit = typeof o.limit === 'number' ? o.limit : 12;
    const segs = Array.isArray(segments) ? segments : [];
    const perSeg = segs.map((s) => {
      const text = str(s && s.text);
      const set = new Set();
      const lat = text.match(/[A-Za-z][A-Za-z0-9+#.\-]{1,}/g) || [];
      lat.forEach((w) => {
        const low = w.toLowerCase().replace(/[.\-]+$/, '');
        if (low.length < 2 || LATIN_STOP.indexOf(low) >= 0) return;
        set.add(low);
      });
      const cjk = text.replace(/[^\u4e00-\u9fff]/g, '#').split('#');
      cjk.forEach((run) => {
        for (let n = 2; n <= 4; n++) {
          for (let i = 0; i + n <= run.length; i++) {
            const g = run.slice(i, i + n);
            if (CJK_STOP.indexOf(g) >= 0) continue;
            // 以虚字开头/结尾的片段不是术语（"的召回"是 n-gram 的已知噪声，写进注释就是为了不复用这条弯路）
            if (GRAM_EDGE_STOP.indexOf(g.charAt(0)) >= 0) continue;
            if (GRAM_EDGE_STOP.indexOf(g.charAt(g.length - 1)) >= 0) continue;
            set.add(g);
          }
        }
      });
      return set;
    });
    const segCount = new Map();
    perSeg.forEach((set) => set.forEach((t) => segCount.set(t, (segCount.get(t) || 0) + 1)));
    let cands = [];
    segCount.forEach((n, term) => { if (n >= minSegs) cands.push({ term: term, segments: n, len: term.length }); });
    // 长的吃掉自己的子片段（同一 segCount 时）
    cands = cands.filter((c) => !cands.some((d) => d !== c && d.segments === c.segments
      && d.len > c.len && d.term.indexOf(c.term) >= 0));
    cands.sort((a, b) => (b.segments - a.segments) || (b.len - a.len) || (a.term < b.term ? -1 : (a.term > b.term ? 1 : 0)));
    return cands.slice(0, limit).map((c) => ({ term: c.term, segments: c.segments }));
  }

  /**
   * cue 列表 → 详细档的三件产物：逐段要点（带时间戳）+ 术语 + 一图读懂的层级。
   *
   * `outline` 的形状（**渲染层/未来"一图读懂"直接用**）：`[{level:0,title}, {level:1,title,at,atText}, …]`
   * —— `level:0` 是主题（粗档已有的那一句），`level:1` 每段一条。**没有编造**：标题就是该段第一句。
   *
   * @param {Array} cues `parseSubtitle` 的产物（或 ffmpeg 适配器转写出来的同形状）
   * @param {{topic?:string}} [opts]
   */
  function outlineFromCues(cues, opts) {
    const o = isObj(opts) ? opts : {};
    const list = Array.isArray(cues) ? cues : [];
    const segs = chunkCues(list);
    const highlights = segs.map((s) => ({
      at: s.start, atText: s.at, endText: s.atEnd,
      text: s.text.length > MAX_HIGHLIGHT_CHARS ? s.text.slice(0, MAX_HIGHLIGHT_CHARS) + '…' : s.text,
      cueCount: s.cueCount
    }));
    const terms = keyTerms(segs);
    const outline = [{ level: 0, title: str(o.topic) || '(未命名)', at: null, atText: null }]
      .concat(segs.map((s) => ({
        level: 1, title: firstSentence(s.text) || ('第 ' + s.index + ' 段'),
        at: s.start, atText: s.at
      })));
    const chars = segs.reduce((n, s) => n + s.text.length, 0);
    return {
      segments: segs, highlights: highlights, terms: terms, outline: outline,
      cueCount: list.length, segCount: segs.length, chars: chars
    };
  }

  /* ==========================================================================
   * 9. 合成（粗档 / 详细档）与结构自查
   * ======================================================================== */

  /** 粗档的字段（**只**用播放列表里便宜读得到的事实 + 目录名；一个字节的内容都不读） */
  function composeCoarse(facts, plan) {
    const f = isObj(facts) ? facts : {};
    const t = isObj(f.totals) ? f.totals : {};
    const seconds = num(t.seconds);
    return {
      target: str(f.target),
      topic: str(f.topic) || '(未命名)',
      durationSeconds: seconds,
      durationText: formatStamp(seconds),
      segments: num(t.segments),
      encrypted: t.encrypted === true,
      structure: Array.isArray(f.structure) ? f.structure : [],
      lessons: Array.isArray(f.videos) ? f.videos.map((v) => ({
        rel: str(v.rel), name: str(v.name), durationSeconds: num(v.seconds),
        durationText: formatStamp(num(v.seconds)), segments: num(v.segments), encrypted: v.encrypted === true
      })) : [],
      subtitleCount: num(t.subtitles),
      playlistCount: num(t.videos),
      level: 'coarse',
      method: plan && plan.method ? plan.method : null,
      why: plan && plan.why ? plan.why : '',
      steps: plan && Array.isArray(plan.steps) ? plan.steps : [],
      caps: plan && plan.caps ? plan.caps : null,
      source: 'playlist-only（只读了播放列表文本 + 目录名：**不解码、不抽帧、不起进程**）'
    };
  }

  /** 把探针给的素材变成 cue 列表：优先 `material.cues`（ffmpeg 转写那一路），否则解析字幕原文 */
  function cuesOfMaterial(material) {
    const m = isObj(material) ? material : {};
    if (Array.isArray(m.cues)) {
      const cues = m.cues.filter((c) => isObj(c) && typeof c.start === 'number' && str(c.text).trim());
      if (!cues.length) return { ok: false, reason: '转写结果里一个带时间戳的句子都没有' , cues: [], warnings: [] };
      return { ok: true, cues: cues, warnings: [], kind: 'transcript' };
    }
    const texts = Array.isArray(m.subtitleTexts) ? m.subtitleTexts : [];
    const cues = [], warnings = [];
    let kind = 'unknown';
    texts.forEach((it) => {
      const src = str(isObj(it) ? (it.rel || it.name) : '');
      const body = str(isObj(it) ? it.text : it);
      const r = parseSubtitle(body, { src: src });
      if (r.kind !== 'unknown') kind = r.kind;
      if (!r.ok) { warnings.push({ kind: r.reason ? 'parse-failed' : 'empty', src: src, reason: r.reason || '' }); return; }
      (r.warnings || []).forEach((w) => warnings.push(Object.assign({ src: src }, w)));
      r.cues.forEach((c) => cues.push(c));
    });
    if (!cues.length) {
      return {
        ok: false, cues: [], warnings: warnings, kind: kind,
        reason: texts.length
          ? ('字幕文件读到了 ' + texts.length + ' 份，但**一个 cue 都解析不出来** —— '
            + '它们不像 .vtt/.srt（没有 `-->` 时间轴行）或正文是空的 ⇒ **没有**拿它们硬算"详细摘要"')
          : '没有字幕文本，也没有转写结果 ⇒ 详细档没有内容源'
      };
    }
    cues.sort((a, b) => (a.start - b.start) || (str(a.text) < str(b.text) ? -1 : (str(a.text) > str(b.text) ? 1 : 0)));
    return { ok: true, cues: cues, warnings: warnings, kind: kind };
  }

  /**
   * 段级要点 → **时间点锚点**（`anchors`）：给"按知识点时间点抽帧"用的那一份清单。
   * 形状 `[{at, atText, text}]`；`at` = 该段的起始秒（就是"讲这个知识点的那一刻"）。
   * **不做任何对齐判断**（"这一帧是不是真的翻页了"要视觉模型）：它只把"什么时候"从一个
   * 人读的时间戳变成机器可用的秒数 —— 于是抽帧从"每 20 秒均匀抽"升级成"讲到哪抽哪"。
   */
  function anchorsOf(highlights) {
    return (Array.isArray(highlights) ? highlights : [])
      .filter((h) => isObj(h) && typeof h.at === 'number' && isFinite(h.at) && h.at >= 0 && str(h.text))
      .map((h) => ({ at: h.at, atText: str(h.atText), text: str(h.text) }));
  }

  /**
   * 计划 + 素材 ⇒ **最终产出**，并且在返回之前**用 `checkSummary` 做一遍结构自查**
   * （自查不过 ⇒ `{ok:false, code:'contract-broken'}`：宁可响亮失败，也不吐一份"看着像"的东西）。
   *
   * 素材（`material`）由**命令层**去取（读字幕 = I/O，属于探针那一侧）：
   *   · `{facts}`                        —— 探针的同类读数（粗档只需要它）
   *   · `{subtitleTexts:[{rel,text}]}`   —— 字幕原文（详细档的 subtitle 那一路）
   *   · `{cues:[{start,end,text}]}`      —— 已带时间戳的句子（详细档的 local-asr/omni/mixed 那几路）
   *   · `{frames:[{at,atText,file}]}`    —— 按锚点抽出来的帧（`mixed` 必须有；`omni` 可缺）
   *   · `{bindings:[{at,atText,frame,text}]}` —— 知识点 ↔ 画面 的绑定（`omni`/`mixed` 必须有）
   *
   * ⚠️ **材料没到位就响亮失败**：`mixed` 定义了"本地 ASR + 图文绑定"，只拿到 ASR 文本时
   * 交一份**没有绑定**的结果，等于把 mixed 悄悄降级成 local-asr 却仍报 mixed —— 那是本工程
   * 最不能容忍的假绿。这里宁可 `no-content-reader`（说清缺哪一步），也不猜、不填空。
   *
   * @param {object} plan `planStrategy` 的 `{ok:true}` 结果
   * @param {object} material 见上
   */
  function buildSummary(plan, material) {
    const p = isObj(plan) ? plan : {};
    const m = isObj(material) ? material : {};
    if (p.ok !== true) {
      return fail(CODES.BAD_PLAN, 'buildSummary 只接受 planStrategy 的**成功**结果（收到 ok=' + JSON.stringify(p.ok) + '）'
        + '—— 计划没成就不许合成产出（否则就是绕过拒绝）');
    }
    const facts = isObj(m.facts) ? m.facts : {};
    const base = composeCoarse(facts, p);
    if (p.level === 'coarse') {
      const sum = base;
      const chk = checkSummary(sum, 'coarse');
      if (!chk.ok) {
        return fail(CODES.CONTRACT_BROKEN, '粗档的产出不满足契约（missing=' + JSON.stringify(chk.missing)
          + ' violations=' + JSON.stringify(chk.violations) + '）—— 不吐出去');
      }
      return { ok: true, summary: sum, contract: chk, warnings: [] };
    }
    // ---- detailed ----
    const got = cuesOfMaterial(m);
    if (!got.ok) return fail(CODES.NO_CUES, got.reason);
    const det = outlineFromCues(got.cues, { topic: base.topic });
    const anchors = anchorsOf(det.highlights);
    const frames = (Array.isArray(m.frames) ? m.frames : [])
      .filter((f) => isObj(f) && typeof f.at === 'number' && str(f.file));
    const bindings = (Array.isArray(m.bindings) ? m.bindings : [])
      .filter((b) => isObj(b) && typeof b.at === 'number' && (str(b.frame) || str(b.file)));
    /* 该路"定义性产物"是不是真拿到了 —— 该要什么**取自契约表本身**（`requiredKeysOf`），
     * 不在这里另写一份"哪条路要哪几件"。 */
    const need = requiredKeysOf('detailed', str(p.method));
    const lacking = [];
    if (need.indexOf('frames') >= 0 && !frames.length) lacking.push('frames');
    if (need.indexOf('bindings') >= 0 && !bindings.length) lacking.push('bindings');
    if (lacking.length) {
      return fail(CODES.NO_CONTENT_READER,
        '**这条路还差材料，不能交**：`' + p.method + '` 要 ' + lacking.join(' + ')
          + '，但这次只拿到了带时间戳的文本（' + got.cues.length + ' 句）。'
          + '（缺的是：' + lacking.map((k) => (k === 'frames'
            ? 'ffmpeg 按锚点抽出来的帧' : '知识点 ↔ 关键帧的绑定')).join('、') + '）'
          + ' ⇒ **不交一份没有' + (lacking.indexOf('bindings') >= 0 ? '图文绑定' : '关键帧') + '的 `'
          + p.method + '` 结果**（那会看起来像成功，其实把这条路悄悄降级了）。'
          + '要现在就能出：`--level coarse`，或改用 `--method subtitle`（有字幕时）');
    }
    const sum = Object.assign({}, base, {
      level: 'detailed',
      cues: det.cueCount,
      segCount: det.segCount,
      chars: det.chars,
      highlights: det.highlights,
      terms: det.terms,
      outline: det.outline,
      parts: det.segments,
      anchors: anchors,
      frames: frames,
      bindings: bindings,
      extractive: true,
      extractiveNote: '要点是**字幕原句**（按停顿切段 + 取段首句），术语是"反复出现的片段"'
        + ' —— 本工程**没有生成式摘要**，不假装有',
      degraded: p.degraded === true,
      degradedFrom: p.degradedFrom || null,
      degradedTo: p.degradedTo || null,
      degradedWhy: p.degradedWhy || null,
      subtitleKind: got.kind
    });
    const chk = checkSummary(sum, 'detailed');
    if (!chk.ok) {
      return fail(CODES.CONTRACT_BROKEN, '详细档的产出不满足契约（missing=' + JSON.stringify(chk.missing)
        + ' violations=' + JSON.stringify(chk.violations) + '）—— 不吐出去');
    }
    return { ok: true, summary: sum, contract: chk, warnings: got.warnings || [] };
  }

  return {
    // 取值表（唯一一处）
    LEVELS, DEFAULT_LEVEL, METHODS, DEFAULT_METHOD, METHOD_KINDS, DECODE_KINDS, MATRIX_AXES, STEP_KINDS,
    COARSE_FORBIDDEN_STEPS, CODES, WHY_EVIDENCE_WORDS, WHY_MIN_CHARS, SUBTITLE_EXT,
    LEVEL_CONTRACT, PATH_SPECS,
    // 四条路的**接口常量**（数值只在这里；理由在 `docs/VIDEO-NOTES.md`）
    ASR_AUDIO, VAD_SEGMENT_SEC, OMNI_SLICE_SEC,
    // ① 能力检测 / ② 选路 / ③ 计划（**唯一决策处**）
    detectCapabilities, missingLinesOf, availableLine, evidenceLine,
    decodePathOf, selectMethod, explicitRefusal, planStrategy,
    // ④ 档位契约
    summarizeContract, requiredKeysOf, judgeWhy, checkSummary,
    // ⑤ 字幕解析（纯文本：当前就能真做的那条路）
    isSubtitleName, detectSubtitleKind, parseStamp, cleanCueText, parseSubtitle,
    // ⑥ 详细档的抽取式合成
    joinCueText, chunkCues, firstSentence, keyTerms, outlineFromCues, anchorsOf,
    // ⑦ 合成 + 自查
    composeCoarse, cuesOfMaterial, buildSummary,
    // ⑧ 小工具（复用 `src/doc-import.js` 的秒数格式化，不另写一份）
    formatStamp, decodesOf, GAP_SEC, MAX_SEG_SEC, MAX_SEG_CUES
  };
});
