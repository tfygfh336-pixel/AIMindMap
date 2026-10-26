# 视频转笔记：三条路 + 一条折中（设计与接口）

<!-- registry（本块是 §5 登记表的**数据源**；改完跑 `npm run docs:registry` 重新生成表）
层: 设计
作用: 「视频 → 笔记」四条内容源路（`subtitle` / `local-asr` / `omni` / `mixed`）的定义、16 格选路矩阵、时间戳对齐抽帧、VAD 分段、成本量级，以及**加密 HLS 输入能不能直接吃**
不该写: 命令用法与选项（→ `docs/CLI.md`）；节点/字段契约（→ `docs/DATA-FORMAT.md` / `docs/ITEM-MODEL.md`）；功能名与代号（→ `docs/FEATURES.md`）；做没做完与待办（→ `docs/ROADMAP.md`）；变更流水（→ `CHANGELOG.md`）；判据与常量的实现（→ `src/video-summary.js` / `src/video-summary-probe.js` 的文件头）
更新方式: 手写。增删一条路、改一格矩阵、改抽帧/VAD/切片口径时，**同批**改本文与 `src/video-summary.js` 里的常量（两边同值有单测对拍），再跑 `npm run docs:registry`
-->

> **读者**：要拿这门课（约 25~30 小时音频）做笔记的人或 AI。
> **边界**：本文只回答四件事 —— 每条路**长什么样**、凭什么**选它**、代价**多大**、输入**能不能吃**。
> 判据的唯一实现在 `src/video-summary.js`（纯逻辑）与 `src/video-summary-probe.js`（副作用面）；
> 本文**不抄代码**，只给"怎么判、为什么这么判、什么还没验证"。
> **每条设计细节的验证状态都写在句子里**（"实测"／"未实测"／"估算"）——
> 本工程铁律第 1 条：写下"支持/会/返回"之前先跑一次；跑不了就显式写"未验证"。

---

## 1. 这份文档管什么（与既有件的分工）

上一批（`20261048`）已经落地了「三条路 + 两档 + 自动检测」：`subtitle` / `ffmpeg` / `hybrid`，
判据在 `src/video-summary.js`（纯逻辑，**零 I/O**），副作用在 `src/video-summary-probe.js`（**每处可注入**）。
那一批的诚实边界是：这台机器**没有 ffmpeg**，ASR 与视觉模型**都没接** ⇒ 只有"有字幕"这一条能真出内容。

这一批（`20261055`）**不写实现运行代码**，只做两件事：

1. 把"只有一条解码路"扩成**四条内容源路**（`subtitle` / `local-asr` / `omni` / `mixed`），
   并把选路从一个 4 格矩阵扩成 **16 格**（`hasSubtitle × hasFfmpeg × hasAsr × hasVision`）；
2. 把**接口形状**落进代码：选路函数、档位契约的按路追加、ffmpeg 的三种新 argv 模式
   （抽音轨 / 按时间点抽帧 / 切片）、HLS 开门参数。

**不在这里写**：命令怎么敲（→ `docs/CLI.md`）、笔记节点怎么建（→ `docs/AI-GUIDE.md` §3）、
做没做完（→ `docs/ROADMAP.md`）。

---

## 2. 四条路的定义（术语沿用既有的，不另造新词）

四条路的机器可读形状在 `src/video-summary.js` 的 `PATH_SPECS`（名字 / 前提 / 步骤 / 产物 / 代价），
下面是人读的那一份。**同一件事两处写就得对拍**：单测逐条核 `PATH_SPECS` 与契约表一致。

### 2.1 `subtitle`（字幕路，**现在唯一能真出内容的一条**）

- **输入**：`.vtt` / `.srt`（判据 `SUBTITLE_EXT`）；**不碰 ffmpeg、不起进程**。
- **步骤**：读文本 → `parseSubtitle` 解析成带时间戳的 cue → 按停顿（`GAP_SEC`）切段 →
  逐段要点（段首句）+ 反复出现的术语 + 一图读懂的层级。
- **产物**：`cues` / `highlights`（带 `at`/`atText`）/ `terms` / `outline` / `anchors`。
- **现状**：能真跑。⚠️ 但**本机这门课一份字幕都没有**（原记 2026-10-26 实测：`.vtt`/`.srt` 共 **0** 份）
  ⇒ 这条路在这份数据上**不成立**，除非另配字幕。

### 2.2 `local-asr`（本地 ASR 路：用户参考里"性价比最高"的那条）

```
加密 HLS ──ffmpeg──> 16 kHz 单声道 wav ──VAD 切段──> 本地 ASR（带时间戳）──> 句级 [start,end,text] ──> 抽取式合成
```

- **输入**：音轨。抽音轨的口径是**固定的**，不是可调参数：`-vn -ac 1 -ar 16000`
  （`ASR_AUDIO = {channels:1, sampleRate:16000}`）。采样率不对时，ASR 会"听起来正常但识别出一堆错字"，
  **而且不会报错** —— 这是最难发现的那一类失败。
- **VAD 分段**：每段 30 秒 ~ 10 分钟（`VAD_SEGMENT_SEC`）。**为什么必需**见 §5。
- **ASR 选型**（三条都行，按手里有没有 GPU 挑；参数细节本文不复述，见各自的出处）：
  | 选型 | 强在哪 | 前提 | 出处（本次只指路，**未逐字核对正文**） |
  |------|--------|------|----------------------------------------|
  | FunASR / Paraformer-zh（阿里开源） | 中文第一梯队，**自带标点 + 句级时间戳 + VAD**；可加 CAM++ 说话人分离 | GPU 4 GB+ 或 CPU | [funasr/paraformer-zh](https://huggingface.co/funasr/paraformer-zh)、[FunASR 说话人分离](https://funasr.com/en/blog/funasr-speaker-diarization.html) |
  | faster-whisper（large-v3 / turbo） | 多语言强、生态成熟、带 word 时间戳、有 `vad_filter` | GPU 6 GB+ | [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) |
  | whisper.cpp（量化） | 纯 CPU / Apple 金属加速，无需 Python 栈 | CPU 即可 | [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) |
- **产物**：与 `subtitle` 同形（cue → 逐段要点），额外必有 `anchors`（时间点锚点）。
- **现状**：**没接**（`probeReaders()` 如实返回 `available:false`）。

### 2.3 `omni`（多模态 API 端到端路：更省事，但贵）

```
加密 HLS ──ffmpeg 按 10 分钟切片──> audio + 关键帧图片 ──混排进同一请求──> 转写 + 摘要 + 图文绑定（一步出）
```

- **前提**：ffmpeg（切片与抽帧）+ 一个**能吃音频且能读图**的多模态 API（qwen-omni / doubao-seed / gemini 这类）。
- **它独有的产出**：**知识点 ↔ 幻灯片截图 的绑定**（`bindings`）。
  `local-asr` **做不到**这一条 —— 转写文本里没有被讲的那张图是什么。所以 `bindings` 在契约里是
  `omni` 的**定义性产物**（缺了就不算 omni，见 §8）。
- **代价**：长音频按 token 计费，是三条里最贵的一档（§6）。
- **已知弱点**：转写幻觉比专用 ASR 高 ⇒ **必须抽查**（这不是"建议"，是这条路成立的前提之一）。
- **现状**：**没接**（`probeReaders()` 的 `vision` 槽位如实 `false`；见 §9 关于"要不要加第五个布尔"）。

### 2.4 `mixed`（折中路，**用户明确推荐**）

- **组成**：`local-asr` 出**免费**的带时间戳文本 + 多模态 API **只做**总结与图文绑定（**不重复转写**）。
- **为什么便宜**：音频不进 API ⇒ 最贵的那部分 token（长音频）被整段省掉，只花在
  "分段要点文本 + 少量关键帧图片"上。用户原话是"成本降一个数量级"；本文按量级核对见 §6。
- **产物**：`anchors` + `frames` + `bindings` 三件齐（缺一件就不算 mixed，见 §8）。
- **现状**：**没接**（需要 ASR **与**视觉同时可用）。

### 2.5 与 `--method` 四个取值的关系（**用户能点的 ≠ 判出来的**）

这是本批最容易混的一处，写清楚：

| 用户能点（`--method`） | 落到哪条路 | 说明 |
|---|---|---|
| `auto`（默认） | 由 16 格矩阵判（§3） | 自动检测 + 给 `why` |
| `subtitle` | `subtitle` | 只吃字幕；没字幕 ⇒ 拒绝（不换路） |
| `hybrid` | `hybrid` = 字幕 + 按点抽帧补画面文字 | 视觉模型没接时**如实降级**到 `subtitle`（`degraded*` 三件） |
| `ffmpeg` | **解码族**：`local-asr` / `omni` / `mixed` / 兜底 `ffmpeg` | 族内落哪一条由能力决定，记在计划的 `via` 字段 |

**三条铁律**（与上一批一致，本批未松）：

1. **显式指定绝不静默回退**：点的那条（或那一族）做不到 ⇒ 非 0 退出 + 说清"现在可用的是哪条"；
2. **族内细化不算换路**：点解码族就只会落在解码族里，**绝不会**跑去字幕族；
3. **新三条路今天不作为 `--method` 的取值**：`--method local-asr` 是 `bad-method`（报文只列四个真取值）。
   理由：`--method` 的取值表同时写在 `cli/registry.js` 与生成物 `docs/CLI.md` 里，扩它必须同批重生成文档；
   而这三条**今天一条也跑不起来**（没 ffmpeg、ASR/视觉没接）⇒ 先把它们做成"可判、可测、可解释的选路结论"，
   等适配器接上再开取值。**这是刻意的顺序，不是漏做**。

---

## 3. 选路矩阵：`hasSubtitle × hasFfmpeg × hasAsr × hasVision`（16 格）

### 3.1 决策规则（**四条，顺序即优先级**）

判据只有一套，在 `selectMethod` / `decodePathOf`（`src/video-summary.js`）：

1. **没有 ffmpeg ⇒ 音轨与帧都取不到**（ASR/视觉"装了也用不上"）⇒ 只剩字幕轴：
   有字幕 ⇒ `subtitle`；没字幕 ⇒ `coarse-only`（并逐条说清缺什么）。
   > 这一条为什么排最前：没有 ffmpeg 时"有 ASR"是个**假前提** —— 不排在前面，矩阵会给出一条跑不通的路。
2. **有 ffmpeg + 有字幕 ⇒ `hybrid`**：**字幕优先于 ASR**。字幕已经是逐句带时间戳的文本，
   不用转写、没有 ASR 幻觉、而且免费且更快 —— 有字幕还去跑 ASR 是白花钱。
   视觉模型没接时选路结论仍是 `hybrid`，**详细档时如实降级**到 `subtitle`。
3. **有 ffmpeg + 没字幕 ⇒ 只能从音轨/画面来**，交 `decodePathOf` 四分：
   有 ASR + 有多模态 ⇒ `mixed`；只有 ASR ⇒ `local-asr`；只有多模态 ⇒ `omni`；都没有 ⇒ `ffmpeg`（兜底格）。
4. **兜底格 `ffmpeg` 的含义**是"解码这一步可行，但解出来没有谁能读" ⇒ 详细档会明确失败
   （`no-content-reader`），**不是**一份摘要。这一格保留着，就是因为"能解码 ≠ 能出内容"这句话必须由代码说出来。

### 3.2 十六格逐格结论

> "详细档"一列答的是：**在今天的实现下**，这一格能不能出一份详细档。
> `no-content-source` 是红线（§8），`no-content-reader` 是"材料/读者缺失"的另一种明确失败。

| # | 字幕 | ffmpeg | ASR | 视觉 | 选路结论 | 详细档 |
|---|------|--------|-----|------|----------|--------|
| 1 | 有 | 有 | 有 | 有 | `hybrid` | 能（抽帧补画面文字） |
| 2 | 有 | 有 | 有 | 无 | `hybrid`（降级 `subtitle`） | 能（画面文字**没有**补进来） |
| 3 | 有 | 有 | 无 | 有 | `hybrid` | 能（抽帧补画面文字） |
| 4 | 有 | 有 | 无 | 无 | `hybrid`（降级 `subtitle`） | 能（同上） |
| 5 | 有 | 无 | 有 | 有 | `subtitle` | 能（ASR/视觉 用不上，缺 ffmpeg） |
| 6 | 有 | 无 | 有 | 无 | `subtitle` | 能 |
| 7 | 有 | 无 | 无 | 有 | `subtitle` | 能 |
| 8 | 有 | 无 | 无 | 无 | `subtitle` | 能 |
| 9 | 无 | 有 | 有 | 有 | `mixed` | 能（**要 ASR + 多模态都接上**） |
| 10 | 无 | 有 | 有 | 无 | `local-asr` | 能（要 ASR 接上） |
| 11 | 无 | 有 | 无 | 有 | `omni` | 能（要多模态接上） |
| 12 | 无 | 有 | 无 | 无 | `ffmpeg`（兜底） | **不能**：`no-content-reader` |
| 13 | 无 | 无 | 有 | 有 | `coarse-only` | **不能**：`no-content-source` |
| 14 | 无 | 无 | 有 | 无 | `coarse-only` | **不能**：`no-content-source` |
| 15 | 无 | 无 | 无 | 有 | `coarse-only` | **不能**：`no-content-source` |
| 16 | 无 | 无 | 无 | 无 | `coarse-only` | **不能**：`no-content-source` |

**这张表由单测逐格穷举守着**（期望表在测试里**独立写一份**，不拿被测实现生成期望）：
任改一格，那一条断言就红。

**每格的 `why` 话术**（"凭什么选它"这句话是给用户看的，不是日志）—— 骨架只有一种：
**证据句 + `⇒` + 结论后缀**。证据句由 `evidenceLine` 拼（"有 N 份字幕 + 本机有/没有 ffmpeg + 读内容的引擎"），
后缀按结论只有这几条：

| 结论 | 后缀（`why` 的后半句） |
|------|------------------------|
| `hybrid` | `⇒ 选 hybrid：字幕给逐句（带时间戳），抽帧补画面里的文字`（视觉没接时后一句换成"详细档时如实降级到 subtitle 那一路"） |
| `subtitle` | `⇒ 选 subtitle：字幕本身就是逐句带时间戳的文本，够做详细档（不需要解码）` |
| `mixed` | `⇒ 选 mixed（折中）：本地 ASR 出免费的时间戳文本，多模态只做总结与图文绑定` |
| `local-asr` | `⇒ 选 local-asr：有本地 ASR ⇒ 音轨转成带时间戳的句子，一次付费为 0` |
| `omni` | `⇒ 选 omni：没有本地 ASR、但有多模态 ⇒ 切片让它端到端出转写+摘要+图文绑定（按 token 计费）` |
| `ffmpeg`（兜底） | `⇒ 选 ffmpeg：解码这一步可行，但解出来没有谁能读（ASR 与视觉模型都没接）⇒ 详细档会明确失败` |
| `coarse-only` | `⇒ 只能粗档（结构 + 时长 + 片数 + 加密 + 课程/课时层级 + 一句话主题）；缺的是：` + 逐条缺失项 |

⚠️ **`why` 有机械判据**（`judgeWhy`）：非空、够长、**必须提到判据依据**（`字幕`/`ffmpeg`/`ASR`/`视觉`/`粗档`/`coarse`/`解码` 至少一个）。
`why="hybrid"` 这种等于没说的答案会被判红 —— 16 格逐格跑过这条判据。

### 3.3 今天哪几格真能出详细档（**本机 + 这份数据的读数**）

- **本机现状**：ffmpeg 不在 PATH；ASR 没接；视觉没接 ⇒ 四个布尔是 `{字幕?, false, false, false}`
  ⇒ 只落在第 5~8 格或第 13~16 格。
- **这份课程数据**：`.vtt`/`.srt` **0 份** ⇒ 实际落在第 **16** 格：**只能出粗档**
  （结构 + 时长 + 片数 + 加密 + 课程/课时层级 + 一句话主题）。
- 换句话说：**今天能真出详细档的只有"有字幕"的那半张表**（1~8 格，且本机只能是 5~8）。
  9~11 格是设计好的落点，**要等 ASR/多模态适配器接上才成立** —— 不允许用"计划里有这条路"冒充"这条路能跑"。
- 这张表**不含文件名**：粗档的 `topic` 只取播放列表名/目录名，详细档的每一行都必须来自内容源。

---

## 4. 时间戳对齐抽帧（取代"每 20 秒均匀抽帧"）

### 4.1 为什么按点抽

均匀抽帧的代价不是"存得多"，而是**信息错位**：

- 一个 10 分钟小节按每 20 秒抽 ⇒ 30 张；而实际翻页可能只有 5~8 次 ⇒ 大部分是同一页的重复，
  另外还有抽在翻页动画中途的**糊帧**。
  （"每 20 秒"是用户参考设计里的现状口径；我们自己的 `frame` 模式缺省是每 10 秒——两者都是"等间隔"，
  本节要换掉的正是**等间隔**这件事，所以间隔取几秒不是重点。）
- 笔记要的是"讲到**这个知识点**时的那张图"，而均匀抽帧只能回答"第 6 分 20 秒的画面"，
  于是图文位置对不上 —— 读者得自己在视频里找。

按点抽的做法：**用内容源自己的时间戳当锚点**（`anchors`：每个逐段要点的起始秒），
对每个锚点抽一帧（`ffmpeg -ss 锚点 -frames:v 1`），再（在 `omni`/`mixed` 里）让模型把锚点与其画面配对（`bindings`）。
字幕路本来就有时间戳（cue 的 `start`），`local-asr`/`omni` 也产出句级时间戳 ⇒ **锚点不额外花钱**。

抽帧点是怎么从锚点算出来的：`frameTimesOf`（纯函数）—— 与前一点相距太近的**跳过**（同一张 PPT），
撞上限的**如实报数**（`dropped.tooClose` / `dropped.overMax`），不静默截断。

### 4.2 `-ss` 放在 `-i` 前 vs 后：**真实差别不是"粗 vs 精"**

流传的说法是"`-ss` 放前面快但粗、放后面准但慢"。按 ffmpeg 自己的文档（[Seeking](https://trac.ffmpeg.org/wiki/Seeking)、
[ffmpeg 手册的 `-ss`](https://ffmpeg.org/ffmpeg.html)），准确的说法是：

- **输入定位**（`-ss` 在 `-i` **前**）：ffmpeg 只能定位到"目标点**之前最近的可定位点**"（关键帧/分片边界），
  然后**默认开启的 `-accurate_seek`** 会把"定位点到目标点"之间的内容解码后丢弃 ⇒ **出帧时刻通常是准的**；
  省下的是"不必从片头开始解"。
- **输出定位**（`-ss` 在 `-i` **后**）：从片头一路解码到目标点再吐帧 ⇒ 同样准，但**每个点都要解一遍全片**。
- 真正会"差几秒"的是 **`-noaccurate_seek`**（或 `-c copy` 这类流拷贝）—— 那时输出就停在定位点上，
  误差 = 目标点到关键帧/分片边界的距离。

⇒ 工程结论（本批落到 `ffmpegArgvOf` 的两个模式）：

| 模式 | argv 里 `-ss` 的位置 | 什么时候用 | 代价 |
|------|---------------------|-----------|------|
| `frame-at` | 在 `-i` **前** | **默认**：一门课几十上百个锚点逐点抽 | 每点最多多解一个分片（本课程 10 秒） |
| `frame-at-accurate` | 在 `-i` **后** | 对拍/取证：抽一个点，确认"前定位到底准不准" | 每点从头解到该点（长视频上很贵） |

⚠️ **本机没有 ffmpeg ⇒ 上面两条 argv 未实测**（拼装是纯函数，单测只证明"拼得对"，
不证明"ffmpeg 会照做"）。第一条实测判据见 §7.4。

### 4.3 HLS 分片给抽帧多加一层限制

我们的输入是 HLS（10 秒一片，`#EXT-X-TARGETDURATION:10`，原记 2026-10-26 实测）⇒ 输入定位的
"最近可定位点"就是**分片边界**。于是：

- 逐点抽帧的**单点代价上限 = 一个分片**（10 秒解码量）—— 这就是选 `frame-at` 而不是 `frame-at-accurate` 的量化理由；
- 若追精确到"翻页那一帧"，靠 `-ss` 定位本身做不到（翻页帧未必是关键帧）；
  该由 `omni`/`mixed` 的**画面理解**来兜（多抽一帧、让模型挑），而不是把 `-ss` 越调越细。

---

## 5. VAD 分段为什么是必需

### 5.1 静音段会"复读"

Whisper 系模型在**长静音/无语音**片段上会输出不存在的句子（常见的是复读上一句、
或凭幻觉吐一句"谢谢观看/字幕由…提供"这类训练集残留）。这不是偶发 bug，而是这类模型
在"没有声音却必须给输出"时的固有行为；社区的标准止血手段就是**先切掉/跳过静音**再送识别
（faster-whisper 直接把 `vad_filter` 做成参数；三方整理见 [Whisper Hallucination 的成因与修法](https://www.yaps.ai/blog/whisper-hallucination)）。

⚠️ 上述出处本次**未取回正文逐字核对**（联网抓取被拒），只用来指路；**本地未实测**
（没装 ffmpeg、没装 ASR）。本工程能机械保证的只有"分段窗口是对的"（常量 + 单测），
"静音处不再复读"要等第一次真跑才成立。

### 5.2 分段窗口：30 秒 ~ 10 分钟

- **下限 30 秒**：更短的段会把一句话切两半，反而制造"半句"；
- **上限 10 分钟**：再长，一段出错就要重跑很长一段（调参数的成本随段长线性涨）。
- 常量在 `VAD_SEGMENT_SEC = {min:30, max:600}`（`src/video-summary.js`），
  计划里的 `transcribe` 步骤会把它**写进 `what`**（执行的人不必回读源码）；
  `omni` 的 `OMNI_SLICE_SEC = 600` 与它同值 —— **故意的**：一次切片正好一段 VAD 上限，
  两套数字漂了就会出现"计划说 10 分钟、实际切了别的"。单测对拍这两个值。

### 5.3 专有名词兜底（转写质量的另一半）

课程里满是产品名/缩写（RAG、PMF、DAU…），专用 ASR 容易写错。两种兜底，**都不改判据、只改善输入**：

- **`initial_prompt`**（whisper 系）：把术语表当提示词前缀喂进去，模型会偏向这些写法；
- **后处理词典纠错**：转写完成后按"错写 → 正写"的映射替换，**只在词边界上替换**，并**如实记录改了哪些**。

> 为什么不做成"自动纠正":那是生成式动作，会把"模型没听清"变成"我们编了一个词"。
> 本工程的立场：**纠错要能被审计**（每次替换都留痕），否则宁可留着错字让人改。

---

## 6. 成本表（基准：约 25~30 小时音频）

**基准来自用户参考设计**（同一门课，25~30 小时）；下表只给**量级**，不写单价 —— 单价是易腐数字，
要用时去各家的当次价目表取。

| 档 | 组成 | 25~30 小时的量级 | 依据 |
|---|------|-----------------|------|
| **纯本地** | `local-asr`（ffmpeg + VAD + 本地 ASR） | **API 花费 0**；时间：4090 级 GPU 约 1 小时跑完；纯 CPU（whisper.cpp 量化）约一天 | 用户参考设计的实测量级；本文**未复测**（本机无 GPU 环境、无 ASR） |
| **纯 API** | `omni` 端到端（切片直接进多模态） | 10 分钟音频 ≈ 15~20 万 token（视模型）；⇒ 25~30 小时 ≈ 150~180 个切片 ⇒ **2 千万 ~ 3.6 千万 token 量级**（估算：片数 × 每片 token） | 每片 token 量来自用户参考设计；片数按 `OMNI_SLICE_SEC` 折算 |
| **混合（推荐）** | `mixed`：本地 ASR 出文本 + API 只做总结/绑定 | 音频**不进** API；只剩"转写文本 + 少量关键帧"⇒ 文本约 30~40 万 token 量级（中文 30 小时 ≈ 40 万字上下）+ 关键帧图片几张到几十张 ⇒ **百万 token 以内**（估算） | 按"音频 token 被整段省掉"推算；用户原话是"降一个数量级"，与这里同向 |

**这张表怎么用**：它回答的是"值不值得接 API"，不是"要花多少钱"。
真要报价时必须**当场**按当日价目表算，并把抽取参数（切片长度、每片送几张图、模型名）一起记下来 ——
否则三个月后没人知道那个数字是哪来的。

---

## 7. ⚠️ HLS 输入：能不能直接吃（本工程与用户参考设计的**最大差异**）

> 用户参考设计的整条流水线是 `MP4 → ...`；**我们手里不是 MP4**，是**加密 HLS**。
> 这一节说不清，前面所有设计都是悬空的。

### 7.1 我们的真实输入形状（本机实测，原记 2026-10-26）

```
E:\markdown\AI产品经理\
  01-AGIC超级个体必修课\第一节_黄金公式\学习中心.m3u8\        ← 注意：名字带 .m3u8，但它是个**目录**
      index.m3u8                                            ← 真正的播放列表（6328 字节）
      index.m3u8.bak                                        ← 备份（19088 字节；扩展名是 .bak ⇒ **不是**播放列表）
      index\0.ts  index\1.ts …                              ← 分片，10 秒一片
      extk0\DVKBTP26BICPT.key                               ← 密钥（AES-128）
```

播放列表头部（原样摘录，仅省略号处为缩写）：

```
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-KEY:METHOD=AES-128,URI="extk0/DVKBTP26BICPT.key",IV=0x12c0dce3…
#EXTINF:10.000000,
index/0.ts
#EXT-X-KEY:METHOD=AES-128,URI="extk0/DVKBTP26BICPT.key",IV=0xd0dc1c35…
#EXTINF:10.000000,
index/1.ts
```

三条要点（都会影响实现）：

1. **每片一条 `#EXT-X-KEY`，且 IV 各不相同**（不是"整个播放列表一个 IV"）。
   ffmpeg 的 hls 解复用器支持这种逐片换 IV 的写法，但**这一点本机未实测**。
2. **密钥 URI 是相对路径**（`extk0/…key`），相对的是**播放列表所在的目录**。
3. 目录里还有一个 `index.m3u8.bak`：扩展名 `.bak` ⇒ 我们的探针不认它是播放列表（`isVideoEntryName` 判 `.m3u8`/`.m3u`）。
   **别手动把它当输入** —— 两份播放列表的分片数可能不同，混用会得到"时长对不上"的怪现象。

### 7.2 三个必答问题

**① 能不能直接吃？** —— **理论上能，本机未实测。**
ffmpeg 自带 hls 解复用器与 AES-128 解密（解密走 `crypto` 协议），所以 `-i index.m3u8` 是"该能行"的那条路；
但"该能行"不是"验证过"：本机 **ffmpeg 不在 PATH**（`Get-Command ffmpeg` / `ffprobe` 都查不到，原记 2026-10-26 实测）。

**② 要不要额外参数？** —— **要，两类。**

- **扩展名白名单**：hls 解复用器只放行一批扩展名，**默认表不含 `key`** ⇒ 本地密钥会被拒。加 `-allowed_extensions ALL`。
- **协议白名单**：读本地密钥要 `file` 协议、AES-128 解密要 `crypto` 协议，而 ffmpeg 对输入里出现的协议有白名单
  ⇒ 加 `-protocol_whitelist file,crypto,data`。社区里这个报错的原话形如
  `Protocol not on whitelist 'file,crypto'`（[Debian #857369](https://bugs.debian.org/cgi-bin/bugreport.cgi?bug=857369)、
  [同题讨论](https://stackoverflow.com/feeds/question/68233509)）。

⇒ 这两类参数已经落成**纯函数** `hlsGuardArgsOf(input)`：**.m3u8/.m3u 才给**，`.mp4` 一个不加
（不给 mp4 加，是为了让"这四条是为 HLS 加的"这件事在 argv 里看得见）。拼好的 argv 单测钉死。

**③ AES-128 密钥要手动处理吗？** —— **不用手动解密**，但有两条硬约束：

- 相对 URI 必须相对**播放列表目录**解析 ⇒ **不能只把 `index.m3u8` 拷到别处**（`extk0/` 与 `index/` 丢了就解不开）；
- 每次按点抽帧都要重新读密钥、重新解密该分片 ⇒ **一门课逐点抽上百帧时，值得先一次性转封装成 mp4**
  （`-c copy`，一次解密），之后在 mp4 上反复 `-ss`。这条是性能取舍，**不是**正确性要求。

### 7.3 建议的调用（**候选写法，不是"已验证"**）

```bash
# ① 抽音轨（给 local-asr / mixed）；HLS 的两个白名单必须在 -i 之前
ffmpeg -hide_banner -nostdin -y -allowed_extensions ALL -protocol_whitelist file,crypto,data \
       -i "…/学习中心.m3u8/index.m3u8" -vn -ac 1 -ar 16000 -f wav out.wav

# ② 按知识点时间点抽一帧（-ss 在 -i 前 = 输入定位；逐点抽用这一条）
ffmpeg -hide_banner -nostdin -y -allowed_extensions ALL -protocol_whitelist file,crypto,data \
       -ss 1234.5 -i "…/index.m3u8" -frames:v 1 shot-1234.jpg

# ③ 兜底：先一次性转封装成 mp4（一次解密），之后在 mp4 上反复定位
ffmpeg -hide_banner -nostdin -y -allowed_extensions ALL -protocol_whitelist file,crypto,data \
       -i "…/index.m3u8" -c copy "/tmp/lesson.mp4"
```

### 7.4 装好 ffmpeg 后**第一条**判据（谁来做、怎么算过）

在真跑整条流水线之前，先跑这三条，**过了再谈设计**（顺序就是排错的顺序）：

1. **能读就算"能直接吃"**：`ffmpeg -hide_banner -allowed_extensions ALL -protocol_whitelist file,crypto,data -i "…/index.m3u8" -t 20 -f null -`
   —— 能正常收尾、不报协议/扩展名错误，即"能直接吃"成立；
2. **报白名单错** ⇒ 按 §7.2 ② 补参数（或确认 ffmpeg 版本策略变了）；
3. **报解密/密钥错** ⇒ 先确认 `extk0/…key` 与播放列表**相对位置没动**，再试 §7.3 ③ 的转封装。

---

## 8. `LEVEL_CONTRACT` 怎么跟着扩（这条红线不许松）

档位契约是**产出的准入判据**（`LEVEL_CONTRACT` + `checkSummary`），本批的扩法是**按路追加**，
不是把所有东西塞进一个 `required` 列表（那会逼每条路都产出别人的产物，最省事的实现就是塞空数组 ⇒ 契约变成形式）。

| 档 | 必备（基础） | 按路追加（`methodRequired`） | 明确禁止 |
|---|-------------|----------------------------|---------|
| `coarse` | 结构 / 时长 / 片数 / 加密 / 层级 / 主题 / 步骤 | 无（粗档没有"路"） | 步骤里出现 `decode`/`frame`/`transcribe`/`bind`/`spawn`；产出 `cues`/`highlights`/`terms`/`outline`/`anchors`/`frames`/`bindings` |
| `detailed` | 上面全部 + 逐段要点 + 术语 + 一图层级 + `extractive:true` | `local-asr` ⇒ `anchors`；`omni` ⇒ `anchors`+`bindings`；`mixed` ⇒ `anchors`+`frames`+`bindings`；`ffmpeg`/`hybrid` ⇒ `anchors`；`subtitle` ⇒ 无 | —（不得假装生成式摘要：`extractive` 必为 true） |

三条判据分层（**别再往一处堆**）：

1. **键在不在** ⇒ `checkSummary`（按 `summary.method` 取 `requiredKeysOf`）；
2. **内容到不到位** ⇒ 合成那一侧（`buildSummary`）：`mixed`/`omni` 缺 `frames`/`bindings` 时返回
   `no-content-reader` 并说清缺哪一步，**不交一份没有绑定的 `mixed`**（悄悄降级成 `local-asr` 却仍报 mixed = 假绿）；
3. **有没有内容源** ⇒ `planStrategy`：`coarse-only` + `detailed` ⇒ `no-content-source`。

> **红线（上一批定的，本批未松）**：**没有内容源就必须 `no-content-source`**。
> 不许拿文件名/目录名拼一份"看着像详细"的摘要 —— 那是本工程最不能容忍的假绿。
> 粗档允许用目录名当 `topic`，是因为粗档**只承诺**"结构 + 时长 + 层级 + 一句话主题"，
> 而那句话不是摘要、也不冒充摘要。

---

## 9. 诚实边界（本批没做什么、会怎样、谁来做）

| 没做 | 后果（如实） | 什么时候做 / 判据 |
|---|---|---|
| **没装 ffmpeg** | `audio`/`frame`/`frame-at`/`slice` 四种 argv 只被"拼装正确"验证过，**没有一条在真 ffmpeg 上跑过**；§7 的 HLS 结论是"理论上能 + 未实测" | 装好后第一条跑 §7.4 的判据 |
| **没接本地 ASR** | `probeReaders().asr.available === false`；第 9、10 格（`mixed`/`local-asr`）在真机上不可达 | 接 FunASR 或 faster-whisper 的常驻/一次性调用；判据：给一段 10 秒 wav 能回 `[{start,end,text}]` |
| **没接多模态 API** | `probeReaders().vision.available === false`；第 9、11 格不可达 | 接一家能手吃音频+图片的 API；判据：一次请求能回"转写 + 要点 + 图↔点绑定" |
| **`--method` 没开新取值** | 用户今天只能点四个值；新三条路只在 `auto` 与 `plan.via` 里出现 | 适配器接上后同批改 `cli/registry.js` 的 usage/desc + `docs-gen` 重生成 `docs/CLI.md` |
| **没有第五个布尔** | `omni` 与"本地视觉模型"共用 `hasVision` 这一位（接哪家是配置问题，不是能力问题）；真要区分要加 `hasOmni`，矩阵 16 → 32 格 | 当"本地视觉"与"omni API"**同时存在且代价差别决定选路**时再加；那是一次显式的矩阵扩表（本文 §3 与单测同批改） |
| **`via` 还没进 CLI 的 `--json`** | `planStrategy` 返回里有 `via`（族内落哪条），但 `video-summary --json` 只转出 `plan.{method,level,decodes,steps}` ⇒ 从命令行看不到它（要从 `method` + `steps` 反推：有 `transcribe`+`frame`+`bind` 就是 `mixed` 那一类形状） | 下批在 `cli/commands/project.js` 的 `--json` 里加一行 `via: plan.via`（本批边界不含该文件，故只记在这里） |
| **VAD 未实现** | 分段窗口是常量与计划里的说明，没有真的静音切分 | 本地 ASR 接上时同批做；判据：一段含 30 秒静音的音频，转写结果里静音段**没有**新句子 |
| **没做说话人分离** | 单人课程无影响；多人课会把两个人的话拼成一段 | 需要时接 CAM++ 之类；判据：已知两人对话的样本上，句级说话人标注与人工标注一致率达标 |
| **没有术语纠错实现** | `initial_prompt`/词典只是设计（§5.3） | 与"转写质量抽查"一起做；判据：一份人工标过的错字清单，纠错后正确率与**误改数**都要报出来 |

---

## 10. 相关判据在哪（改本文时同批核这几处）

| 要核什么 | 唯一实现处 |
|---|---|
| 选路规则 / 16 格 / `via` | `src/video-summary.js` 的 `selectMethod` · `decodePathOf` · `planStrategy` |
| 四条路的形状（前提/步骤/产物） | `src/video-summary.js` 的 `PATH_SPECS` |
| 常量（`ASR_AUDIO` / `VAD_SEGMENT_SEC` / `OMNI_SLICE_SEC`） | `src/video-summary.js`；`OMNI_SLICE_SEC` 在探针侧还有一份缺省值（单测对拍） |
| 档位契约 / 按路追加 | `src/video-summary.js` 的 `LEVEL_CONTRACT` · `requiredKeysOf` · `checkSummary` |
| ffmpeg argv / HLS 参数 / 抽帧点 | `src/video-summary-probe.js` 的 `ffmpegArgvOf` · `hlsGuardArgsOf` · `frameTimesOf` |
| 上面这些的穷举与注入判据 | `tests/video-summary.test.js`（B/C/E 老四格 + J/K/L/M 新矩阵与契约） |
| 本批的差异表与证据 | `.review/20261055-视频转笔记/README.md` |
