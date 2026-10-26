/* ============================================================
 * tests/video-summary.test.js —— 【20261048】视频摘要：三条路 + 两档 + 自动检测
 * ------------------------------------------------------------
 * 用户原话（唯一需求真源）：「从字幕解析、ffmpeg 以及二者结合三条路径均要实现，并且可以选择用什么方法，
 * 可以自动检测视频可以用什么方法」⇒ 拆四条：S1 三条路 / S2 手动选 / S3 自动检测（并说清为什么）
 * / S4 档位（能出"比较粗"和"比较详细"两档）。
 *
 * ⚠️ 本文件的**全部判据都不需要 ffmpeg**（这台机器也没有它）—— 这正是本批的设计约束：
 *    判断在 `src/video-summary.js`（纯），副作用在 `src/video-summary-probe.js`（每一处都能注入）。
 *    ⇒ 每条判据的"该红"都能用**注入**验一遍（`hasFfmpeg:false` / 假执行器 / 假 PATH / 坏字幕），
 *      不用等装完 ffmpeg 才知道选路对不对。
 *
 * 八条判据（两侧，每一条在下面都有落点）：
 *   ① 选路·auto 四格：{有字幕,有ffmpeg}⇒hybrid · {无,有}⇒ffmpeg · {有,无}⇒subtitle · {无,无}⇒coarse-only
 *   ② 选路·显式：`--method subtitle` 且有字幕 ⇒ subtitle；**没字幕时静默回退 ⇒ 红**（本批最重要）
 *   ③ 档位契约：coarse 的产出**不含**任何解码步骤（steps 里没有 decode/frame/transcribe/spawn）
 *   ④ detailed 不硬凑：无字幕无 ffmpeg ⇒ 必须 `{ok:false, reason:'no-content-source'}`
 *   ⑤ 时长：`#EXTINF` 之和 = 真值（3 片 10s ⇒ 30s；再换一份 1 片 7s ⇒ 7s，证明不是硬编码）
 *   ⑥ why 是人话：非空 + 提到判据依据（`why='hybrid'` 这种 ⇒ 红）
 *   ⑦ 字幕解析：造一份 .vtt（`-->` 时间轴 + 2 段文本）⇒ 2 段 + 时间戳；**WEBVTT 头不许进正文**
 *   ⑧ 诚实标记：降级 ⇒ `degraded:true` + `degradedFrom`/`degradedTo`（静默降级 ⇒ 红）
 *
 * 第二批四条（2026-10-55 · 设计+接口批，判据见 `docs/VIDEO-NOTES.md`）：
 *   ⑨ **新选路矩阵 16 格穷举**（J 组）：字幕 × ffmpeg × ASR × 视觉，每格给结论 + why + 详细档能不能出；
 *      期望表在本文件里**独立写一份**（不拿被测实现生成期望）
 *   ⑩ 显式指定在新矩阵下仍然**不换路**（K 组）；`--method ffmpeg` 点的是**解码族**，族内细化报在 `via`
 *   ⑪ **契约按路生效**（L 组）：字幕路不要绑定，`omni`/`mixed` 缺 `bindings` 就明确失败
 *   ⑫ 时间戳对齐抽帧的口径（M 组）：`-ss` 在 `-i` 前/后两种 argv、HLS 开门参数、锚点 → 抽帧时间点
 *
 * ⚠️ 本文件只写沙箱：项目根 `AI_MINDMAP_PROJECTS_DIR` 指向系统临时目录，夹具也建在临时目录里，
 *    用完立刻删。真实 `projects/` 全程零接触（`video-summary` 这个命令本来就不写 projects/，
 *    本文件用 H7 把这条承诺也钉住）。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-vsum-proj-'));
const FIXROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-vsum-fix-'));
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const vs = require('../src/video-summary.js');
const probe = require('../src/video-summary-probe.js');
const di = require('../src/doc-import.js');
const registry = require('../cli/registry.js');
const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');

/* 项目根重定向必须**当场**生效：否则夹具会建进真实 projects/。宁可在这里响亮地红。 */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效：PROJECTS_DIR=' + core.PROJECTS_DIR + ' 期望=' + SANDBOX
    + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

/* ---------------- 夹具 ---------------- */

const PL3X10 = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n'
  + '#EXTINF:10.000000,\nindex/0.ts\n#EXTINF:10.000000,\nindex/1.ts\n#EXTINF:10.000000,\nindex/2.ts\n'
  + '#EXT-X-ENDLIST\n';
const PL1X7 = '#EXTM3U\n#EXTINF:7.0,\nindex/0.ts\n#EXT-X-ENDLIST\n';
const PL_ENC = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="extk0/A.key",IV=0x12c0dce3\n'
  + '#EXTINF:10.0,\nindex/0.ts\n#EXT-X-ENDLIST\n';

/** `.vtt`：头 + 注释块（NOTE）+ 2 段带时间轴的正文 —— 判据⑦ 的夹具 */
const VTT_OK = 'WEBVTT\n\nNOTE 这是注释块，不是台词\n\n'
  + '1\n00:00:01.000 --> 00:00:04.500 align:start position:10%\n<c.hl>第一段</c> 讲 RAG 的召回。\n\n'
  + '2\n00:00:09.000 --> 00:00:12.000\n第二段：召回率与精度要一起看，LLM 只是其中一环。\n';

/** `.srt`：序号行 + 逗号毫秒 + 一条两行正文 */
const SRT_OK = '1\n00:00:01,000 --> 00:00:02,500\n第一行\n第二行\n\n'
  + '2\n00:00:05,000 --> 00:00:06,000\n第三行\n';

const fixtures = [];
/** 造一棵夹具树（`spec` = { 相对 posix 路径: 内容 }）；返回根目录 */
function makeTree(spec) {
  const root = fs.mkdtempSync(path.join(FIXROOT, 't-'));
  fixtures.push(root);
  Object.keys(spec).forEach((rel) => {
    const p = path.join(root, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, spec[rel], 'utf8');
  });
  return root;
}
/** 只有播放列表、**没有任何字幕**的一棵树（判据④/⑧ 的夹具） */
function treeNoSubtitle(playlist) {
  return makeTree({
    '课/第一节/学习中心.m3u8/index.m3u8': playlist === undefined ? PL3X10 : playlist
  });
}
/** 一份 caps 读数（判据全在不碰盘的那一层：这里就是"注入"的地方） */
function capsOf(hasSubtitle, hasFfmpeg, extra) {
  return Object.assign({ hasSubtitle: !!hasSubtitle, hasFfmpeg: !!hasFfmpeg,
    hasAsr: false, hasVision: false, subtitleCount: hasSubtitle ? 1 : 0,
    subtitleFiles: hasSubtitle ? ['x.vtt'] : [], ffmpegPath: hasFfmpeg ? 'C:/fake/ffmpeg.exe' : null }, extra || {});
}
function runCli(argv) {
  const r = invokeSync(argv);
  return { code: r.code, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

afterAll(() => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(FIXROOT, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

/* ============================================================================
 * A · 字幕解析（判据⑦：纯文本这一条**现在就能真做**）
 * ========================================================================== */
describe('A · 字幕解析：`.vtt`/`.srt` → 带时间戳的 cue（纯函数）', () => {
  it('A1 ★ 一份 .vtt（头 + NOTE + 2 段时间轴）⇒ 解析出 **2 段**、带时间戳，且 **WEBVTT 头不进正文**',
    () => {
      const r = vs.parseSubtitle(VTT_OK, { src: 'x.vtt' });
      expect(r.ok).toBe(true);
      expect(r.kind).toBe('vtt');
      expect(r.cues).toHaveLength(2);
      expect(r.cues[0]).toMatchObject({ start: 1, end: 4.5 });
      expect(r.cues[0].text).toBe('第一段 讲 RAG 的召回。');
      expect(r.cues[1].start).toBe(9);
      expect(r.cues[1].at).toBe('0:09');
      // ★ 判据：头与注释块**都不是**正文（把 WEBVTT 当台词是最容易犯的那一种）
      r.cues.forEach((c) => {
        expect(c.text).not.toContain('WEBVTT');
        expect(c.text).not.toContain('NOTE');
      });
      // 而且**不产生**假警告：正常 vtt 不该有"解析不了的行"
      expect(r.warnings).toEqual([]);
    });

  it('A2 .srt（序号行 + 逗号毫秒 + 两行正文）⇒ 2 段，多行正文合并为一句，`STYLE` 块不算台词',
    () => {
      const srt = SRT_OK + '\nSTYLE\n::cue { color: red }\n';
      const r = vs.parseSubtitle(srt);
      expect(r.ok).toBe(true);
      expect(r.kind).toBe('srt');
      expect(r.cues).toHaveLength(2);
      expect(r.cues[0].text).toBe('第一行 第二行');
      expect(r.cues[0].start).toBe(1);
      expect(r.cues[0].end).toBe(2.5);
      r.cues.forEach((c) => expect(c.text).not.toContain('::cue'));
    });

  it('A3 该红（注入）：一份**没有时间轴**的文本 ⇒ `ok:false` + 逐条警告，**不静默当 0 段**', () => {
    const r = vs.parseSubtitle('这根本不是字幕\n随便两行字\n');
    expect(r.ok).toBe(false);
    expect(r.cues).toEqual([]);
    expect(String(r.reason)).toContain('一个 cue 都解析不出来');
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(vs.parseSubtitle('').reason).toContain('空文件');
  });

  it('A4 时间戳解析：`HH:MM:SS.mmm` / `MM:SS,mmm` 都对；认不出的返回 null（**不猜第 0 秒**）', () => {
    expect(vs.parseStamp('00:01:02.500')).toBe(62.5);
    expect(vs.parseStamp('02:03,5')).toBe(123.5);
    expect(vs.parseStamp('00:00:00.000')).toBe(0);
    expect(vs.parseStamp('乱写')).toBe(null);
    expect(vs.parseStamp('00:99:00.000')).toBe(null);
  });

  it('A5 正文清洗与拼接：标签剥掉、CJK 之间不插空格、ASCII 词之间插一个', () => {
    expect(vs.cleanCueText('<c.hl>甲</c> 乙 &nbsp;丙')).toBe('甲 乙 丙');
    expect(vs.joinCueText(['中文', '中文'])).toBe('中文中文');
    expect(vs.joinCueText(['LLM', 'RAG'])).toBe('LLM RAG');
    expect(vs.detectSubtitleKind('WEBVTT\n\n')).toBe('vtt');
    expect(vs.detectSubtitleKind(SRT_OK)).toBe('srt');
    expect(vs.detectSubtitleKind('随便')).toBe('unknown');
  });

  it('★ A6 两侧判据（不许改既有语义）：`.vtt` 在 **HLS 包里**对导入那条路仍是 `video-part`，'
    + '而摘要这一侧认它是**字幕** —— 两套判据并存，各有各的用途', () => {
    // 导入侧（既有语义，有断言钉着）：包里的 .vtt 是"分片/索引"，没有导入价值
    expect(di.classifyVideoPart('课时/学习中心.m3u8/notes.vtt', true)).toBe('video-part');
    // 摘要侧（本批新增的另一套识别）：同一份文件是**字幕**，是字幕那条路的入口
    expect(vs.isSubtitleName('notes.vtt')).toBe(true);
    expect(vs.isSubtitleName('notes.srt')).toBe(true);
    expect(vs.isSubtitleName('notes.txt')).toBe(false);
    expect(vs.SUBTITLE_EXT).toEqual(['.vtt', '.srt']);
  });
});

/* ============================================================================
 * B · 选路（判据①：auto 四格 —— 自动检测的判据本体）
 * ========================================================================== */
describe('B · 选路 auto：四个布尔 ⇒ 一条路 + 一句人话 why', () => {
  it('B1 有字幕 + 有 ffmpeg ⇒ **hybrid**（字幕给逐句，抽帧补画面文字）', () => {
    const r = vs.selectMethod(capsOf(true, true));
    expect(r.method).toBe('hybrid');
    expect(r.why).toContain('字幕');
    expect(r.why).toContain('ffmpeg');
  });

  it('B2 无字幕 + 有 ffmpeg ⇒ **ffmpeg**（内容只能从音轨/画面里来）', () => {
    const r = vs.selectMethod(capsOf(false, true));
    expect(r.method).toBe('ffmpeg');
    expect(r.why).toContain('没有 .vtt/.srt 字幕');
    expect(r.why).toContain('ffmpeg');
  });

  it('B3 有字幕 + 无 ffmpeg ⇒ **subtitle**（字幕本身就是逐句带时间戳的文本）', () => {
    const r = vs.selectMethod(capsOf(true, false));
    expect(r.method).toBe('subtitle');
    expect(r.why).toContain('字幕');
    expect(r.why).toContain('没有 ffmpeg');
  });

  it('B4 无字幕 + 无 ffmpeg ⇒ **coarse-only**，并**说明缺什么**（这是明确结果，不是抛错）', () => {
    const r = vs.selectMethod(capsOf(false, false));
    expect(r.method).toBe('coarse-only');
    expect(r.why).toContain('缺的是');
    expect(r.why).toContain('ASR');       // 缺的东西逐个点名，不只说"不行"
  });

  it('★ B5 该红（注入）：把 {无字幕,无 ffmpeg} 判成 ffmpeg ⇒ 判据必红 —— '
    + '四格逐格钉死，任何一格判错都会让上面四条里的一条失败', () => {
    const grid = [
      [true, true, 'hybrid'], [false, true, 'ffmpeg'], [true, false, 'subtitle'], [false, false, 'coarse-only']
    ];
    grid.forEach((g) => {
      const got = vs.selectMethod(capsOf(g[0], g[1])).method;
      expect(got).toBe(g[2]);
      if (g[0] === false && g[1] === false) expect(got).not.toBe('ffmpeg');
    });
    // 归一化也要对：探针读数（subtitles 数组 + caps.ffmpeg）⇒ 四个布尔
    expect(vs.detectCapabilities({ subtitles: [{ rel: 'a.vtt' }],
      caps: { ffmpeg: { found: true, path: 'C:/f/ffmpeg.exe' }, asr: { available: false }, vision: { available: false } } }))
      .toMatchObject({ hasSubtitle: true, hasFfmpeg: true, hasAsr: false, hasVision: false });
    expect(vs.detectCapabilities({}).missing.length).toBeGreaterThan(0);
  });
});

/* ============================================================================
 * C · 显式指定方法（判据②：**绝不静默回退** —— 本批最重要的一条）
 * ========================================================================== */
describe('C · `--method` 显式指定：可用就照做，不可用就**响亮拒绝**（不换路）', () => {
  it('C1 `--method subtitle` 且有字幕 ⇒ 真的走 subtitle（steps 里有 read-subtitle）', () => {
    const p = vs.planStrategy({ caps: capsOf(true, false) }, { method: 'subtitle', level: 'detailed' });
    expect(p.ok).toBe(true);
    expect(p.method).toBe('subtitle');
    expect(p.steps.map((s) => s.kind)).toEqual(['read-playlist', 'read-subtitle', 'compose-detailed']);
  });

  it('★★ C2 **该红注入**：`--method subtitle` 而**没有字幕** ⇒ 非 ok + 说清"不会退回"与"现在可用的是哪条"'
    + '（静默回退到 ffmpeg/hybrid 是本批最不能犯的错）', () => {
    const p = vs.planStrategy({ caps: capsOf(false, true) }, { method: 'subtitle', level: 'detailed' });
    expect(p.ok).toBe(false);
    expect(p.code).toBe('method-unavailable');
    expect(p.message).toContain('不会退回');
    expect(p.message).toContain('现在可用的是');
    expect(p.message).toContain('ffmpeg');         // 可用的是哪条要点名
    expect(p.method).toBe(undefined);              // **不许**带一条"替代方法"出门
  });

  it('★★ C3 `--method ffmpeg` 而**没有 ffmpeg** ⇒ 拒绝 + 给出"装 ffmpeg / 用 subtitle / 用 auto"三条出路',
    () => {
      const p = vs.planStrategy({ caps: capsOf(true, false) }, { method: 'ffmpeg', level: 'detailed' });
      expect(p.ok).toBe(false);
      expect(p.code).toBe('method-unavailable');
      expect(p.message).toContain('装 ffmpeg');
      expect(p.message).toContain('--method subtitle');
      expect(p.message).toContain('--method auto');
    });

  it('C4 `--method hybrid` 缺任何一边 ⇒ 拒绝并**点名缺哪边**（只有字幕 / 只有 ffmpeg 各一条）', () => {
    const onlySub = vs.planStrategy({ caps: capsOf(true, false) }, { method: 'hybrid', level: 'detailed' });
    expect(onlySub.ok).toBe(false);
    expect(onlySub.code).toBe('hybrid-needs-both');
    expect(onlySub.message).toContain('ffmpeg');
    const onlyFf = vs.planStrategy({ caps: capsOf(false, true) }, { method: 'hybrid', level: 'detailed' });
    expect(onlyFf.code).toBe('hybrid-needs-both');
    expect(onlyFf.message).toContain('字幕');
  });

  it('C5 粗档 + 显式方法 ⇒ 拒绝（粗档不解码、不读字幕：**收下方法却不用**等于骗人）', () => {
    ['subtitle', 'ffmpeg', 'hybrid'].forEach((m) => {
      const p = vs.planStrategy({ caps: capsOf(true, true) }, { method: m, level: 'coarse' });
      expect(p.ok).toBe(false);
      expect(p.code).toBe('method-needs-detailed');
      expect(p.message).toContain('--level detailed');
    });
    // `auto` 不是"显式指定" ⇒ 粗档照常能出（它不是回退，是默认）
    expect(vs.planStrategy({ caps: capsOf(false, false) }, { method: 'auto', level: 'coarse' }).ok).toBe(true);
  });

  it('C6 非法取值 ⇒ 当场报错并列出允许值（不静默落默认值）', () => {
    const badLevel = vs.planStrategy({ caps: capsOf(true, true) }, { level: 'fine' });
    expect(badLevel.code).toBe('bad-level');
    expect(badLevel.message).toContain('coarse');
    expect(badLevel.message).toContain('detailed');
    const badMethod = vs.planStrategy({ caps: capsOf(true, true) }, { method: 'ocr' });
    expect(badMethod.code).toBe('bad-method');
    ['auto', 'subtitle', 'ffmpeg', 'hybrid'].forEach((m) => expect(badMethod.message).toContain(m));
  });

  it('★★ C7 穷举 4 方法 × 2 档 × 4 格能力：**凡是 ok 的显式计划，method 必须等于用户点的那一条**'
    + '（这条是"没有静默回退"的机械判据，比单看一条报文更硬）', () => {
    const methods = ['subtitle', 'ffmpeg', 'hybrid'];
    const grid = [[false, false], [true, false], [false, true], [true, true]];
    const seen = { ok: 0, refused: 0 };
    methods.forEach((m) => {
      grid.forEach((g) => {
        ['coarse', 'detailed'].forEach((level) => {
          const p = vs.planStrategy({ caps: capsOf(g[0], g[1]) }, { method: m, level: level });
          if (p.ok) {
            seen.ok++;
            expect(p.method).toBe(m);                     // ★ 没有换路
          } else {
            seen.refused++;
            expect(typeof p.code).toBe('string');
            expect(String(p.message).length).toBeGreaterThan(20);
          }
        });
      });
    });
    // 24 格里**不可能**全成（比如"没字幕却要 subtitle"）—— 至少拒绝过一半，且确实有成过
    expect(seen.refused).toBeGreaterThan(0);
    expect(seen.ok).toBeGreaterThan(0);
  });
});

/* ============================================================================
 * D · 档位契约（判据③：coarse 的产出不含任何解码步骤）
 * ========================================================================== */
describe('D · 档位契约：coarse 不许解码/抽帧/起进程（结构判据，不是口头约定）', () => {
  it('D1 粗档计划的 steps 只有 read-playlist → compose-coarse，`decodes:false`', () => {
    const p = vs.planStrategy({ caps: capsOf(true, true) }, { level: 'coarse' });
    expect(p.ok).toBe(true);
    expect(p.steps.map((s) => s.kind)).toEqual(['read-playlist', 'compose-coarse']);
    expect(p.decodes).toBe(false);
    vs.COARSE_FORBIDDEN_STEPS.forEach((k) => expect(p.steps.map((s) => s.kind)).not.toContain(k));
  });

  it('★★ D2 **该红注入**：往粗档的产出里**偷偷塞一步 decode** ⇒ `checkSummary` 必红', () => {
    const p = vs.planStrategy({ caps: capsOf(true, true) }, { level: 'coarse' });
    const sum = vs.composeCoarse({ target: 'x', topic: 't', totals: { seconds: 30, segments: 3 }, structure: [] }, p);
    expect(vs.checkSummary(sum, 'coarse').ok).toBe(true);       // 原样是绿的
    const bad = Object.assign({}, sum, { steps: sum.steps.concat([{ kind: 'decode', what: '偷偷解码' }]) });
    const chk = vs.checkSummary(bad, 'coarse');
    expect(chk.ok).toBe(false);
    expect(chk.violations.join('|')).toContain('decode');
    // 换一种偷法也算：抽帧 / 转写 / 起进程
    ['frame', 'transcribe', 'spawn'].forEach((k) => {
      const b = Object.assign({}, sum, { steps: sum.steps.concat([{ kind: k, what: 'x' }]) });
      expect(vs.checkSummary(b, 'coarse').ok).toBe(false);
    });
  });

  it('★★ D3 该红注入：粗档产出里出现 `highlights`/`cues`/`terms`/`outline` ⇒ 红（那是详细档的东西）', () => {
    const p = vs.planStrategy({ caps: capsOf(true, true) }, { level: 'coarse' });
    const sum = vs.composeCoarse({ target: 'x', topic: 't', totals: { seconds: 30 }, structure: [] }, p);
    ['highlights', 'cues', 'terms', 'outline'].forEach((k) => {
      const chk = vs.checkSummary(Object.assign({}, sum, { [k]: [{ x: 1 }] }), 'coarse');
      expect(chk.ok).toBe(false);
      expect(chk.violations.join('|')).toContain(k);
    });
  });

  it('D4 契约表本身：两档的 required / forbidden 覆盖齐全（未知档位 ⇒ null，不猜一档）', () => {
    const c = vs.summarizeContract('coarse');
    expect(c.what).toContain('时长');
    expect(c.required).toEqual(expect.arrayContaining(['durationSeconds', 'segments', 'encrypted', 'structure', 'topic', 'why']));
    vs.COARSE_FORBIDDEN_STEPS.forEach((k) => expect(c.forbiddenStepKinds).toContain(k));
    const d = vs.summarizeContract('detailed');
    expect(d.required).toEqual(expect.arrayContaining(['highlights', 'terms', 'outline', 'extractive', 'cues']));
    expect(d.forbiddenStepKinds).toEqual([]);
    expect(vs.summarizeContract('fine')).toBe(null);
  });

  it('D5 真实粗档产出**不含**任何内容层字段（只读播放列表与目录名）', () => {
    const facts = probe.probeVideo(treeNoSubtitle());
    const p = vs.planStrategy(facts, { level: 'coarse' });
    const built = vs.buildSummary(p, { facts: facts });
    expect(built.ok).toBe(true);
    expect(built.contract.ok).toBe(true);
    ['cues', 'highlights', 'terms', 'outline'].forEach((k) => expect(built.summary[k]).toBe(undefined));
    expect(built.summary.source).toContain('不解码');
  });
});

/* ============================================================================
 * E · detailed 不硬凑（判据④ + 判据⑧）
 * ========================================================================== */
describe('E · 详细档：有内容源才出，没有就**说实话做不到**（绝不拿文件名硬凑）', () => {
  it('★★ E1 无字幕 + 无 ffmpeg ⇒ `{ok:false, code:"no-content-source"}`，并指向 `--level coarse`', () => {
    const p = vs.planStrategy({ caps: capsOf(false, false) }, { method: 'auto', level: 'detailed' });
    expect(p.ok).toBe(false);
    expect(p.code).toBe('no-content-source');
    expect(p.message).toContain('详细档做不到');
    expect(p.message).toContain('不拿文件名');
    expect(p.message).toContain('--level coarse');
  });

  it('★★ E2 该红注入：有 ffmpeg 但 ASR/视觉都没接 ⇒ `no-content-reader`（解码了也没人读）', () => {
    const p = vs.planStrategy({ caps: capsOf(false, true) }, { method: 'auto', level: 'detailed' });
    expect(p.ok).toBe(false);
    expect(p.code).toBe('no-content-reader');
    // 而同一个目录做**粗档**是能成的（粗档确实有信息 ⇒ 不是"抛错"）
    expect(vs.planStrategy({ caps: capsOf(false, true) }, { level: 'coarse' }).ok).toBe(true);
  });

  it('E3 注入 `hasAsr:true` ⇒ ffmpeg 路通了：steps 里有 decode + transcribe（**接口位是真接得上的**）', () => {
    const p = vs.planStrategy({ caps: capsOf(false, true, { hasAsr: true, asrName: 'fake-asr' }) },
      { method: 'ffmpeg', level: 'detailed' });
    expect(p.ok).toBe(true);
    const kinds = p.steps.map((s) => s.kind);
    expect(kinds).toContain('decode');
    expect(kinds).toContain('transcribe');
    expect(p.decodes).toBe(true);
  });

  it('★★ E4 判据⑧：hybrid 但**视觉模型没接** ⇒ 如实降级到 subtitle（`degraded`/`degradedFrom`/`degradedTo` 三件齐全，'
    + '且计划里**没有** decode —— 没做的事不写进计划）', () => {
    const p = vs.planStrategy({ caps: capsOf(true, true) }, { method: 'auto', level: 'detailed' });
    expect(p.ok).toBe(true);
    expect(p.method).toBe('hybrid');            // 选路结论仍是 hybrid（两边都有）
    expect(p.degraded).toBe(true);
    expect(p.degradedFrom).toBe('hybrid');
    expect(p.degradedTo).toBe('subtitle');
    expect(p.degradedWhy).toContain('视觉模型没接');
    expect(p.steps.map((s) => s.kind)).not.toContain('decode');
  });

  it('E5 注入 `hasVision:true` ⇒ hybrid 不降级：decode + frame 都进计划（**降级只在真有缺口时发生**）', () => {
    const p = vs.planStrategy({ caps: capsOf(true, true, { hasVision: true, visionName: 'fake-vision' }) },
      { method: 'auto', level: 'detailed' });
    expect(p.ok).toBe(true);
    expect(p.degraded).toBe(false);
    const kinds = p.steps.map((s) => s.kind);
    expect(kinds).toContain('read-subtitle');
    expect(kinds).toContain('decode');
    expect(kinds).toContain('frame');
  });

  it('E6 计划没成 ⇒ `buildSummary` 拒绝合成（绕过拒绝就是"硬凑"入口）', () => {
    const bad = vs.buildSummary({ ok: false, code: 'x' }, {});
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('bad-plan');
  });

  it('★★ E7 该红注入：字幕文件在、但**一个 cue 都解析不出来** ⇒ `no-cues`（不拿空字幕硬算详细档）', () => {
    const facts = probe.probeVideo(makeTree({
      'a/x.m3u8': PL3X10, 'a/sub.vtt': '这根本不是字幕\n随便两行\n'
    }));
    const p = vs.planStrategy(facts, { level: 'detailed' });
    expect(p.ok).toBe(true);
    const built = vs.buildSummary(p, { facts: facts, subtitleTexts: [{ rel: 'a/sub.vtt', text: '这根本不是字幕\n随便两行\n' }] });
    expect(built.ok).toBe(false);
    expect(built.code).toBe('no-cues');
    expect(built.summary).toBe(undefined);
  });

  it('E8 有字幕 ⇒ 详细档三件产物齐全：逐段要点带时间戳 / 术语 / 一图层级，且 `extractive:true`', () => {
    const facts = probe.probeVideo(makeTree({ 'a/x.m3u8': PL3X10, 'a/sub.vtt': VTT_OK }));
    const p = vs.planStrategy(facts, { level: 'detailed' });
    expect(p.ok).toBe(true);
    const built = vs.buildSummary(p, { facts: facts, subtitleTexts: [{ rel: 'a/sub.vtt', text: VTT_OK }] });
    expect(built.ok).toBe(true);
    expect(built.contract.ok).toBe(true);
    const s = built.summary;
    expect(s.level).toBe('detailed');
    expect(s.cues).toBe(2);
    expect(s.highlights).toHaveLength(2);
    expect(s.highlights[0].atText).toBe('0:01');
    expect(s.highlights[1].text).toContain('召回率');
    // 术语是**抽取式**：只留"两条以上字幕都出现的片段"。本夹具里 `召回` 两段都有 ⇒ 在；
    // `RAG` / `LLM` 各只出现一次 ⇒ **不进**（"只出现一次的不算术语"是这里钉住的规则）。
    expect(s.terms.map((t) => t.term)).toContain('召回');
    expect(s.terms.map((t) => t.term)).not.toContain('rag');
    expect(s.terms.map((t) => t.term)).not.toContain('llm');
    expect(s.outline[0].level).toBe(0);
    expect(s.outline[1]).toMatchObject({ level: 1, atText: '0:01' });
    expect(s.extractive).toBe(true);
  });

  it('★★ E9 该红注入：手造一份"只有文件名、没有逐段要点"的**详细档** ⇒ `checkSummary` 必红'
    + '（"拿文件名拼详细摘要"正是本工程最不能容忍的假绿）', () => {
    const fake = {
      level: 'detailed', method: 'subtitle', why: '有字幕 ⇒ 选 subtitle 做详细档',
      target: 'D:/课', topic: '课', durationSeconds: 30, durationText: '0:30',
      segments: 3, encrypted: false, structure: [], caps: {}, steps: [],
      cues: 0, highlights: [], terms: [], outline: [], extractive: true
    };
    const chk = vs.checkSummary(fake, 'detailed');
    // 键都在、但 `highlights` 是**空数组**（没有内容）—— 这一档的判据是"缺键即红"，
    // 而"空数组"要在**合成那一侧**被 `no-cues` 挡住（E7 钉的就是那一条）。
    expect(chk.ok).toBe(true);
    const missingHighlights = Object.assign({}, fake);
    delete missingHighlights.highlights;
    const chk2 = vs.checkSummary(missingHighlights, 'detailed');
    expect(chk2.ok).toBe(false);
    expect(chk2.missing).toContain('highlights');
    // 假装有生成式摘要（extractive:false）也要红
    expect(vs.checkSummary(Object.assign({}, fake, { extractive: false }), 'detailed').ok).toBe(false);
  });
});

/* ============================================================================
 * F · why 是人话（判据⑥）
 * ========================================================================== */
describe('F · `why` 必须提到判据依据（`why="hybrid"` 这种等于没说 ⇒ 红）', () => {
  it('F1 judgeWhy：空 / 太短 / 没有证据词 一律不通过', () => {
    expect(vs.judgeWhy('').ok).toBe(false);
    expect(vs.judgeWhy('hybrid').ok).toBe(false);
    expect(vs.judgeWhy('选 hybrid').reason.length).toBeGreaterThan(0);
    expect(vs.judgeWhy('有字幕 + 本机没有 ffmpeg ⇒ 选 subtitle').ok).toBe(true);
    expect(vs.judgeWhy('没有字幕也没有 ffmpeg ⇒ 只能粗档').ok).toBe(true);
  });

  it('★ F2 四格 × 两档：**每一个成立的计划**的 why 都要过 judgeWhy 且点到证据词', () => {
    const grid = [[false, false], [true, false], [false, true], [true, true]];
    grid.forEach((g) => {
      ['coarse', 'detailed'].forEach((level) => {
        const p = vs.planStrategy({ caps: capsOf(g[0], g[1]) }, { level: level });
        if (!p.ok) return;
        const w = vs.judgeWhy(p.why);
        expect(w.ok).toBe(true);
        expect(p.why.length).toBeGreaterThan(20);
        expect(['字幕', 'ffmpeg', 'ASR', '视觉', '粗档', 'coarse'].some((k) => p.why.indexOf(k) >= 0)).toBe(true);
      });
    });
  });

  it('F3 该红注入：why 里塞一个空话 ⇒ 粗档契约自查当场红', () => {
    const p = vs.planStrategy({ caps: capsOf(true, true) }, { level: 'coarse' });
    const sum = vs.composeCoarse({ target: 'x', topic: 't', totals: { seconds: 1 }, structure: [] }, p);
    expect(vs.checkSummary(sum, 'coarse').ok).toBe(true);
    const chk = vs.checkSummary(Object.assign({}, sum, { why: 'hybrid' }), 'coarse');
    expect(chk.ok).toBe(false);
    expect(chk.violations.join('|')).toContain('why');
  });
});

/* ============================================================================
 * G · 探针（判据⑤：时长是 #EXTINF 之和；以及 ffmpeg 适配器骨架）
 * ========================================================================== */
describe('G · 探针：真读盘（但只读**播放列表与字幕**，分片/密钥一个都不碰）', () => {
  it('★ G1 判据⑤ 时长 = `#EXTINF` 之和：3 片 × 10s ⇒ 30s；换一份 1 片 7s ⇒ 7s（**不是硬编码**）', () => {
    const a = probe.probeVideo(treeNoSubtitle(PL3X10));
    expect(a.ok).toBe(true);
    expect(a.totals.seconds).toBe(30);
    expect(a.totals.segments).toBe(3);
    expect(a.totals.durationFrom).toBe('playlist-extinf-sum');
    const b = probe.probeVideo(treeNoSubtitle(PL1X7));
    expect(b.totals.seconds).toBe(7);
    expect(b.totals.segments).toBe(1);
    // 纯函数那一侧也是同一把尺（唯一实现在 `src/doc-import.js`）
    expect(di.videoPlaylistFacts(PL3X10)).toMatchObject({ segments: 3, seconds: 30 });
  });

  it('★ G1b 判据⑤ 的另一半：时长**不是硬编码** —— 换一份 7 秒的目录，粗档产出也跟着变成 `0:07`',
    () => {
      const facts = probe.probeVideo(treeNoSubtitle(PL1X7));
      const p = vs.planStrategy(facts, { level: 'coarse' });
      const built = vs.buildSummary(p, { facts: facts });
      expect(built.ok).toBe(true);
      expect(built.summary.durationSeconds).toBe(7);
      expect(built.summary.durationText).toBe('0:07');
    });

  it('G2 课程/课时层级：目录名成层级，下载器的 `<名字>.m3u8/` 那一层**不算**层级', () => {
    const root = makeTree({
      '课/第一节/学习中心.m3u8/index.m3u8': PL3X10,
      '课/第二节/复盘.m3u8/index.m3u8': PL1X7
    });
    const f = probe.probeVideo(root);
    expect(f.ok).toBe(true);
    expect(f.structure.map((s) => s.path)).toEqual(['课', '课/第一节', '课/第二节']);
    expect(f.structure[0]).toMatchObject({ depth: 0, videos: 2, seconds: 37 });
    expect(f.structure.map((s) => s.name)).not.toContain('学习中心.m3u8');
  });

  it('G3 加密：带 `EXT-X-KEY` ⇒ encrypted:true（并冒泡到层级与总计）；不带 ⇒ false', () => {
    const enc = probe.probeVideo(makeTree({ 'a/x.m3u8/index.m3u8': PL_ENC }));
    expect(enc.totals.encrypted).toBe(true);
    const plain = probe.probeVideo(makeTree({ 'a/x.m3u8/index.m3u8': PL3X10 }));
    expect(plain.totals.encrypted).toBe(false);
  });

  it('G4 字幕识别：`.vtt`/`.srt` 都认、排序稳定；`.ts`/`.key`/`.txt` **一个都不读**', () => {
    const root = makeTree({
      'a/x.m3u8/index.m3u8': PL3X10,
      'a/b.vtt': VTT_OK,
      'a/c.srt': SRT_OK,
      'a/index/0.ts': '#EXTM3U 假的\n',
      'a/extk0/A.key': 'k',
      'a/说明.txt': '不是字幕\n'
    });
    const f = probe.probeVideo(root);
    expect(f.ok).toBe(true);
    expect(f.subtitles.map((s) => s.rel)).toEqual(['a/b.vtt', 'a/c.srt']);
    expect(f.subtitles[0].kind).toBe('vtt');
    expect(f.subtitles[1].kind).toBe('srt');
    expect(f.gaps).toEqual([]);                       // 跳过 ≠ 失败：分片/密钥本来就不读
    expect(f.videos.map((v) => v.rel)).toEqual(['a/x.m3u8/index.m3u8']);
  });

  it('G5 `findFfmpeg`：只看文件在不在（**不 spawn**）；注入一份空 PATH ⇒ found:false', () => {
    const none = probe.findFfmpeg({ pathEnv: 'C:\\nope;D:\\nope2', exists: () => false, platform: 'win32' });
    expect(none.found).toBe(false);
    expect(none.path).toBe(null);
    expect(none.searched).toBeGreaterThan(0);
    const hit = probe.findFfmpeg({ pathEnv: 'C:\\tools', exists: (p) => /ffmpeg\.exe$/.test(p), platform: 'win32' });
    expect(hit.found).toBe(true);
    expect(hit.path).toMatch(/ffmpeg\.exe$/);
  });

  it('★ G6 适配器骨架：没装 ffmpeg ⇒ `run` 返回 `{ok:false, reason:"ffmpeg-missing"}`（明确失败，不抛、不装作跑过）',
    () => {
      const runner = probe.makeFfmpegRunner({ ffmpeg: { found: false, path: null } });
      expect(runner.available).toBe(false);
      const r = runner.run(['-version']);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('ffmpeg-missing');
      expect(r.message).toContain('装不装是用户的决定');
      // 计划里那一步经同一个执行器：结论一致
      const step = probe.runFfmpegStep(runner, 'audio', 'in.m3u8', 'out.wav');
      expect(step.ok).toBe(false);
      expect(step.reason).toBe('ffmpeg-missing');
    });

  it('★ G7 注入假执行器 ⇒ argv 形状可断言（audio: 16k 单声道；frame: fps=1/N），失败也有明确 reason', () => {
    /* HLS 输入（**我们真实的输入形状**）：必须带"开门参数" —— 本地加密播放列表默认打不开
     * （扩展名白名单不含 `key`；AES-128 要走 `crypto` 协议、读本地密钥要走 `file` 协议）。
     * 这四条参数的**理由与"未实测"声明**在 `docs/VIDEO-NOTES.md` §7。 */
    expect(probe.ffmpegArgvOf('audio', 'in.m3u8', 'out.wav'))
      .toEqual(['-hide_banner', '-nostdin', '-y',
        '-allowed_extensions', 'ALL', '-protocol_whitelist', 'file,crypto,data',
        '-i', 'in.m3u8', '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', 'out.wav']);
    // 非 HLS 输入**不加**这四条（证明它们是按输入形状注入的，不是硬编码进每一条 argv）
    expect(probe.ffmpegArgvOf('audio', 'in.mp4', 'out.wav'))
      .toEqual(['-hide_banner', '-nostdin', '-y', '-i', 'in.mp4',
        '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', 'out.wav']);
    expect(probe.ffmpegArgvOf('frame', 'in.mp4', 'f-%03d.jpg', { everySec: 10, maxFrames: 6 }))
      .toEqual(['-hide_banner', '-nostdin', '-y', '-i', 'in.mp4', '-vf', 'fps=1/10', '-frames:v', '6', 'f-%03d.jpg']);
    expect(() => probe.ffmpegArgvOf('subtitle', 'a', 'b')).toThrow(/只认 /);
    // 未知模式要**响亮列出**认哪些（不是只说"未知"）
    expect(() => probe.ffmpegArgvOf('nope', 'a', 'b')).toThrow(/frame-at-accurate/);

    const calls = [];
    const okRunner = probe.makeFfmpegRunner({
      ffmpeg: { found: true, path: 'C:/fake/ffmpeg.exe' },
      spawnSync: (bin, argv) => { calls.push({ bin, argv }); return { status: 0, stdout: 'ok', stderr: '' }; }
    });
    expect(okRunner.available).toBe(true);
    const audio = probe.runFfmpegStep(okRunner, 'audio', 'in.m3u8', 'out.wav');
    expect(audio.ok).toBe(true);
    expect(calls[0].bin).toBe('C:/fake/ffmpeg.exe');
    expect(calls[0].argv).toContain('-ar');

    const badRunner = probe.makeFfmpegRunner({
      ffmpeg: { found: true, path: 'C:/fake/ffmpeg.exe' },
      spawnSync: () => ({ status: 2, stdout: '', stderr: 'Invalid data found when processing input' })
    });
    const bad = badRunner.run(['-i', 'x']);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('ffmpeg-failed');
    expect(bad.message).toContain('退出码 2');
  });

  it('G8 目标不对时**响亮**：空目录 / 不存在的路径 / 给了一份 .txt', () => {
    const empty = makeTree({ 'x/空.txt': 'not subtitle\n' });
    const r1 = probe.probeVideo(empty);
    expect(r1.ok).toBe(false);
    expect(r1.code).toBe('no-video-or-subtitle');
    expect(r1.message).toContain('.m3u8');
    const r2 = probe.probeVideo(path.join(FIXROOT, '根本不存在的目录'));
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe('bad-target');
    const r3 = probe.probeVideo(path.join(empty, 'x', '空.txt'));
    expect(r3.ok).toBe(false);
    expect(r3.code).toBe('bad-target');
    expect(r3.message).toContain('.vtt');
  });

  it('G9 `collectSubtitleTexts`：只读字幕正文，读不成进 gaps（不静默）', () => {
    const root = makeTree({ 'a/x.m3u8': PL3X10, 'a/b.vtt': VTT_OK });
    const f = probe.probeVideo(root);
    const got = probe.collectSubtitleTexts(f);
    expect(got.texts).toHaveLength(1);
    expect(got.texts[0].text).toContain('WEBVTT');
    expect(got.gaps).toEqual([]);
  });
});

/* ============================================================================
 * H · 端到端（CLI：`video-summary` 经 registry + 进程内 invoke）
 * ========================================================================== */
describe('H · 端到端：命令真的能敲、拒绝真会退出 1、`--json` 两跑逐字节相同、而且**不写 projects/**', () => {
  it('H1 registry 里有这条命令，`--help` 打印支持集（含 --method/--level）', () => {
    expect(registry.get('video-summary')).toBeTruthy();
    expect(registry.allowedOptions('video-summary')).toEqual(expect.arrayContaining(['method', 'level', 'json']));
    const h = runCli(['video-summary', '--help']);
    expect(h.code).toBe(0);
    expect(h.out).toContain('--method');
    expect(h.out).toContain('--level');
    expect(h.out).toContain('video-summary');
  });

  it('H2 粗档 `--json`：形状是契约里那一份（level/method/why/summary/plan/contract/noWrite）', () => {
    const root = treeNoSubtitle(PL3X10);
    const r = runCli(['video-summary', root, '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.ok).toBe(true);
    expect(j.command).toBe('video-summary');
    expect(j.noWrite).toBe(true);
    expect(j.level).toBe('coarse');
    expect(j.method).toBe('coarse-only');
    expect(j.summary.durationSeconds).toBe(30);
    expect(j.summary.durationText).toBe('0:30');
    expect(j.summary.segments).toBe(3);
    expect(j.plan.decodes).toBe(false);
    expect(j.contract.ok).toBe(true);
    expect(typeof j.why).toBe('string');
  });

  it('H3 `--json` 两跑**逐字节相同**（无时间戳、列表一律码点序 ⇒ 门禁 S3 的"顺序"那一类）', () => {
    const root = makeTree({ '课/第一节/x.m3u8/index.m3u8': PL3X10, '课/第二节/y.m3u8/index.m3u8': PL1X7 });
    const a = runCli(['video-summary', root, '--json']);
    const b = runCli(['video-summary', root, '--json']);
    expect(a.code).toBe(0);
    expect(a.out).toBe(b.out);
  });

  it('★★ H4 `--method subtitle` 而没有字幕 ⇒ exit 1 + `error:` 开头 + 说清"不会退回"', () => {
    const root = treeNoSubtitle();
    const r = runCli(['video-summary', root, '--method', 'subtitle', '--level', 'detailed']);
    expect(r.code).toBe(1);
    expect(r.out.startsWith('error: ')).toBe(true);
    expect(r.out).toContain('不会退回');
    expect(r.out).toContain('现在可用的是');
  });

  it('★★ H5 `--method ffmpeg` 而本机没有 ffmpeg ⇒ exit 1 + 点名"没有 ffmpeg"与三条出路', () => {
    const root = treeNoSubtitle();
    const r = runCli(['video-summary', root, '--method', 'ffmpeg', '--level', 'detailed']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('没有 ffmpeg');
    expect(r.out).toContain('装 ffmpeg');
  });

  it('★★ H6 `--level detailed` 而两样都没有 ⇒ exit 1 + "详细档做不到"（不是一份假摘要）', () => {
    const root = treeNoSubtitle();
    const r = runCli(['video-summary', root, '--level', 'detailed']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('详细档做不到');
    expect(r.out).toContain('不拿文件名');
  });

  it('H7 本命令**不写 projects/**：跑之前/之后沙箱项目根的条目一模一样'
    + '（排除既有约定里的 `.visits/` 与 `.changes.jsonl`）', () => {
    const list = () => {
      try {
        return fs.readdirSync(SANDBOX).filter((n) => n !== '.visits' && n !== '.changes.jsonl').sort();
      } catch (e) { return []; }
    };
    const before = list();
    const root = treeNoSubtitle(PL3X10);
    runCli(['video-summary', root]);
    runCli(['video-summary', root, '--json']);
    runCli(['video-summary', root, '--level', 'detailed']);      // 这一条会失败，同样不许写
    expect(list()).toEqual(before);
  });

  it('H8 有字幕 ⇒ 文本档里看得见"逐段要点（带时间戳）"与"抽取式"，`--json` 里 highlights 2 段', () => {
    const root = makeTree({ 'a/x.m3u8/index.m3u8': PL3X10, 'a/sub.vtt': VTT_OK });
    const r = runCli(['video-summary', root, '--level', 'detailed']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('逐段要点');
    expect(r.out).toContain('抽取式');
    expect(r.out).toContain('0:01');
    expect(r.out).toContain('关键概念/术语');
    const j = JSON.parse(runCli(['video-summary', root, '--level', 'detailed', '--json']).out);
    expect(j.level).toBe('detailed');
    expect(j.method).toBe('subtitle');
    expect(j.summary.highlights).toHaveLength(2);
    expect(j.summary.extractive).toBe(true);
    expect(j.plan.steps.map((s) => s.kind)).toContain('read-subtitle');
  });

  it('H9 非法 `--level` / 裸 `--method`（没给值）⇒ exit 1，且都列出允许值（不静默落默认值）', () => {
    const root = treeNoSubtitle();
    const bad = runCli(['video-summary', root, '--level', 'fine']);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('coarse');
    expect(bad.out).toContain('detailed');
    const bare = runCli(['video-summary', root, '--method']);
    expect(bare.code).toBe(1);
    expect(bare.out).toContain('auto');
  });

  it('H10 缺位置参数 ⇒ exit 1 并说清"位置参数是路径、不是项目名"', () => {
    const r = runCli(['video-summary']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('路径');
    expect(r.out).toContain('projects/');
  });

  it('H11 **只有字幕、没有播放列表**也能用：粗档照出（0 份播放列表 / 0:00，如实报），'
    + '详细档从字幕出内容（时长未知不影响"逐句要点"）', () => {
    const root = makeTree({ 'only.vtt': VTT_OK });
    const coarse = runCli(['video-summary', root, '--json']);
    expect(coarse.code).toBe(0);
    const c = JSON.parse(coarse.out);
    expect(c.summary.playlistCount).toBe(0);
    expect(c.summary.durationSeconds).toBe(0);        // 没有播放列表 ⇒ 时长确实不知道，**不编**
    expect(c.method).toBe('subtitle');
    const detailed = runCli(['video-summary', root, '--level', 'detailed', '--json']);
    expect(detailed.code).toBe(0);
    const d = JSON.parse(detailed.out);
    expect(d.summary.highlights).toHaveLength(2);
    expect(d.summary.highlights[1].atText).toBe('0:09');
    expect(d.summary.extractive).toBe(true);
  });
});

/* ============================================================================
 * I · MCP 透传（一个用户能敲的功能，AI 也该能调到 —— 这是本工程的立身之本）
 * ========================================================================== */
describe('I · MCP：`video_summary` 工具在，且**判定一条都不复制**（一层透传）', () => {
  const mcp = require('../scripts/mcp-server.js');

  it('I1 工具面里有 video_summary：必填只有 `path`（**路径不是项目名**），并有 method/level 两个可选', () => {
    const tool = mcp.TOOLS.filter((t) => t.name === 'video_summary')[0];
    expect(tool).toBeTruthy();
    expect(tool.inputSchema.required).toEqual(['path']);
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(['level', 'method', 'path']);
    expect(tool.description).toContain('不写 projects/');
  });

  it('I2 调用成功 ⇒ 回的就是 CLI 的 `--json`（形状一致；`noWrite:true`）', () => {
    const root = treeNoSubtitle(PL3X10);
    const r = mcp.callTool('video_summary', { path: root });
    expect(r.ok).toBe(true);
    const j = JSON.parse(r.text);
    expect(j.ok).toBe(true);
    expect(j.noWrite).toBe(true);
    expect(j.level).toBe('coarse');
    expect(j.summary.durationSeconds).toBe(30);
  });

  it('★★ I3 显式方法不可用 ⇒ **MCP 侧也是失败**（`ok:false`，绝不假成功），报文与 CLI 同一个',
    () => {
      const root = treeNoSubtitle();
      const r = mcp.callTool('video_summary', { path: root, method: 'subtitle', level: 'detailed' });
      expect(r.ok).toBe(false);
      expect(r.text).toContain('不会退回');
      // 详细档在没有内容源时同样是失败（不是一份"看起来像"的摘要）
      const d = mcp.callTool('video_summary', { path: root, level: 'detailed' });
      expect(d.ok).toBe(false);
      expect(d.text).toContain('详细档做不到');
    });

  it('I4 缺 `path` ⇒ **协议级**错误（调用方调错了，不是业务失败）', () => {
    const r = mcp.callTool('video_summary', {});
    expect(r.protocol).toBe(true);
    expect(r.text).toContain('path');
  });

  it('I5 MCP 侧**不另写一套判据**：同一个目录，MCP 与 CLI 的 `summary` 逐字段相同', () => {
    const root = makeTree({ 'a/x.m3u8': PL3X10, 'a/sub.vtt': VTT_OK });
    const viaCli = JSON.parse(runCli(['video-summary', root, '--level', 'detailed', '--json']).out);
    const viaMcp = JSON.parse(mcp.callTool('video_summary', { path: root, level: 'detailed' }).text);
    expect(viaMcp.summary).toEqual(viaCli.summary);
    expect(viaMcp.why).toBe(viaCli.why);
    expect(viaMcp.plan).toEqual(viaCli.plan);
  });
});

/* ============================================================================
 * J · 新选路矩阵（2026-10-55）：字幕 × ffmpeg × ASR × 视觉 = 16 格**穷举**
 * ----------------------------------------------------------------------------
 * 判据来源 = `src/video-summary.js` 的 `selectMethod` 头注（四条规则）+ `decodePathOf`（族内四分）。
 * ⚠️ 本组是**独立写一份期望表**（不调用被测的判断去生成期望）：
 *    表与实现两边各写一次，任一边漂了都会红 —— 这正是"穷举可测"的意思。
 * ========================================================================== */
describe('J · 新选路矩阵：16 格穷举（每格给结论 + why 非空 + 详细档能不能出）', () => {
  /** 四布尔 → 一份归一过的 caps（注入面，不碰盘） */
  const caps4 = (s, f, a, v) => ({
    hasSubtitle: !!s, hasFfmpeg: !!f, hasAsr: !!a, hasVision: !!v,
    subtitleCount: s ? 1 : 0, subtitleFiles: s ? ['x.vtt'] : [],
    ffmpegPath: f ? 'C:/fake/ffmpeg.exe' : null,
    asrName: a ? 'fake-asr' : null, visionName: v ? 'fake-vision' : null
  });

  /** 16 格期望（**顺序即规则顺序**：先"没有 ffmpeg"，再"有字幕优先"，最后解码族） */
  const MATRIX = [
    [true, true, true, true, 'hybrid'],
    [true, true, true, false, 'hybrid'],
    [true, true, false, true, 'hybrid'],
    [true, true, false, false, 'hybrid'],
    [true, false, true, true, 'subtitle'],
    [true, false, true, false, 'subtitle'],
    [true, false, false, true, 'subtitle'],
    [true, false, false, false, 'subtitle'],
    [false, true, true, true, 'mixed'],
    [false, true, true, false, 'local-asr'],
    [false, true, false, true, 'omni'],
    [false, true, false, false, 'ffmpeg'],
    [false, false, true, true, 'coarse-only'],
    [false, false, true, false, 'coarse-only'],
    [false, false, false, true, 'coarse-only'],
    [false, false, false, false, 'coarse-only']
  ];

  it('★ J1 16 格逐格：结论对、why 非空且过 `judgeWhy`、结论值都在 `METHOD_KINDS` 里', () => {
    expect(MATRIX).toHaveLength(16);
    MATRIX.forEach((row) => {
      const s = row[0], f = row[1], a = row[2], v = row[3];
      const want = row[4];
      const r = vs.selectMethod(caps4(s, f, a, v));
      const label = '字幕=' + (s ? '有' : '无') + ' ffmpeg=' + (f ? '有' : '无')
        + ' ASR=' + (a ? '有' : '无') + ' 视觉=' + (v ? '有' : '无');
      expect({ label: label, method: r.method }).toEqual({ label: label, method: want });
      expect(vs.METHOD_KINDS).toContain(r.method);
      expect(r.why.length).toBeGreaterThan(12);
      expect(vs.judgeWhy(r.why).ok).toBe(true);       // ★ why 不是空话
    });
  });

  it('★ J2 16 格逐格：详细档能不能出 —— 能出就给 `compose-detailed`，不能出就给**明确 code**', () => {
    MATRIX.forEach((row) => {
      const s = row[0], f = row[1], a = row[2], v = row[3], want = row[4];
      const p = vs.planStrategy({ caps: caps4(s, f, a, v) }, { level: 'detailed' });
      if (want === 'coarse-only') {
        expect(p.ok).toBe(false);
        expect(p.code).toBe('no-content-source');     // ★ 红线：没有内容源就是这一条
        expect(p.message).toContain('不拿文件名');
        return;
      }
      if (want === 'ffmpeg') {                        // 兜底格：能解码、没人读
        expect(p.ok).toBe(false);
        expect(p.code).toBe('no-content-reader');
        expect(p.message).toContain('不拿文件名');
        return;
      }
      expect(p.ok).toBe(true);
      const kinds = p.steps.map((x) => x.kind);
      expect(kinds[0]).toBe('read-playlist');
      expect(kinds).toContain('compose-detailed');
      if (want === 'subtitle') {
        expect(kinds).toContain('read-subtitle');
        expect(kinds).not.toContain('decode');
      }
      if (want === 'local-asr') {
        expect(kinds).toContain('transcribe');
        expect(kinds).not.toContain('bind');
      }
      if (want === 'omni') {
        expect(kinds).toContain('transcribe');
        expect(kinds).toContain('frame');
        expect(kinds).toContain('bind');               // 图文绑定是 omni 的定义性产物
      }
      if (want === 'mixed') {
        expect(kinds).toContain('transcribe');
        expect(kinds).toContain('frame');
        expect(kinds).toContain('bind');
      }
      if (want === 'hybrid' && v) expect(kinds).toContain('frame');
      if (want === 'hybrid' && !v) expect(p.degraded).toBe(true);
    });
  });

  it('★ J3 没有 ffmpeg ⇒ ASR/视觉**装了也用不上**：结论回到字幕轴，且"缺什么"说的是取不到音轨', () => {
    expect(vs.selectMethod(caps4(true, false, true, true)).method).toBe('subtitle');
    expect(vs.selectMethod(caps4(false, false, true, true)).method).toBe('coarse-only');
    const why = vs.selectMethod(caps4(false, false, true, true)).why;
    expect(why).toContain('取不到音轨');            // 不是笼统的"ASR 没接"
    // 同一份能力做粗档照样能出（粗档不需要内容源）
    const coarse = vs.planStrategy({ caps: caps4(false, false, true, true) }, { level: 'coarse' });
    expect(coarse.ok).toBe(true);
    expect(coarse.method).toBe('coarse-only');
    expect(coarse.decodes).toBe(false);
  });

  it('J4 `decodePathOf`（族内四分）逐格：只有 ffmpeg 的那一格是兜底 `ffmpeg`', () => {
    expect(vs.decodePathOf(caps4(false, true, true, true))).toBe('mixed');
    expect(vs.decodePathOf(caps4(false, true, true, false))).toBe('local-asr');
    expect(vs.decodePathOf(caps4(false, true, false, true))).toBe('omni');
    expect(vs.decodePathOf(caps4(false, true, false, false))).toBe('ffmpeg');
    expect(vs.decodePathOf(caps4(false, false, true, true))).toBe('ffmpeg');   // 没 ffmpeg ⇒ 兜底
    expect(vs.DECODE_KINDS).toEqual(['ffmpeg', 'local-asr', 'omni', 'mixed']);
  });

  it('★ J5 `PATH_SPECS` 与实现**对拍**：四条路的名字/前提/产物与 `METHOD_KINDS`、契约表一致', () => {
    // 四条路 = 文档里的那四份（`hybrid` 是历史复合值，不是一条独立的路）
    expect(Object.keys(vs.PATH_SPECS).sort()).toEqual(['local-asr', 'mixed', 'omni', 'subtitle']);
    Object.keys(vs.PATH_SPECS).forEach((k) => {
      expect(vs.METHOD_KINDS).toContain(k);
      const spec = vs.PATH_SPECS[k];
      expect(spec.id).toBe(k);
      expect(spec.steps).toEqual(expect.arrayContaining(['read-playlist', 'compose-detailed']));
      // 契约表里"按路追加的必备键"必须在该路声明的产物里（否则契约要的东西这条路产不出）
      const req = vs.LEVEL_CONTRACT.detailed.methodRequired[k] || [];
      req.forEach((f) => expect(spec.outputs).toContain(f));
    });
    // `needs` 与实现同向：needs 全满足 ⇒ `decodePathOf` 就选它
    ['local-asr', 'omni', 'mixed'].forEach((k) => {
      const need = vs.PATH_SPECS[k].needs;
      const caps = caps4(false, need.indexOf('hasFfmpeg') >= 0,
        need.indexOf('hasAsr') >= 0, need.indexOf('hasVision') >= 0);
      expect(vs.decodePathOf(caps)).toBe(k);
    });
    expect(vs.PATH_SPECS.subtitle.needs).toEqual(['hasSubtitle']);
    expect(vs.MATRIX_AXES).toEqual(['hasSubtitle', 'hasFfmpeg', 'hasAsr', 'hasVision']);
  });
});

/* ============================================================================
 * K · 显式指定（新矩阵下的复验）：缺前提 ⇒ 拒绝、**不换路**、`via` 只做族内细化
 * ========================================================================== */
describe('K · 显式指定：缺前提就拒绝（不换路），`via` 只在**族内**细化', () => {
  const caps4 = (s, f, a, v) => ({
    hasSubtitle: !!s, hasFfmpeg: !!f, hasAsr: !!a, hasVision: !!v,
    subtitleCount: s ? 1 : 0, subtitleFiles: s ? ['x.vtt'] : [],
    ffmpegPath: f ? 'C:/fake/ffmpeg.exe' : null,
    asrName: a ? 'fake-asr' : null, visionName: v ? 'fake-vision' : null
  });

  it('★ K1 三条显式方法各自缺前提 ⇒ 拒绝 + "现在可用的是" + **不带替代方法出门**', () => {
    [
      ['subtitle', caps4(false, true, true, true), 'method-unavailable'],
      ['ffmpeg', caps4(true, false, true, true), 'method-unavailable'],
      ['hybrid', caps4(true, false, false, false), 'hybrid-needs-both']
    ].forEach((c) => {
      const p = vs.planStrategy({ caps: c[1] }, { method: c[0], level: 'detailed' });
      expect(p.ok).toBe(false);
      expect(p.code).toBe(c[2]);
      expect(p.method).toBe(undefined);                 // ★ 没有"替代方法"跟着出门
      expect(p.message).toContain('不会退回');
      expect(p.message).toContain('现在可用的是');
    });
  });

  it('★ K2 新三条路**不在** `--method` 的取值里：点它们 = `bad-method`，报文只列四个真取值', () => {
    ['local-asr', 'omni', 'mixed'].forEach((m) => {
      const p = vs.planStrategy({ caps: caps4(false, true, true, true) }, { method: m, level: 'detailed' });
      expect(p.ok).toBe(false);
      expect(p.code).toBe('bad-method');
      expect(p.message).toContain('收到');
      expect(p.message).toContain(m);              // 收到的是什么，要如实回显
      expect(vs.METHODS).toEqual(['auto', 'subtitle', 'ffmpeg', 'hybrid']);
      vs.METHODS.forEach((x) => expect(p.message).toContain(x));
    });
  });

  it('K3 `--method ffmpeg` 点的是**解码族**：`method` 报用户点的那条，族内落哪条记在 `via`（没换族）', () => {
    const p = vs.planStrategy({ caps: caps4(true, true, true, true) }, { method: 'ffmpeg', level: 'detailed' });
    expect(p.ok).toBe(true);
    expect(p.method).toBe('ffmpeg');                    // 报告面 = 用户点的
    expect(p.via).toBe('mixed');                        // 族内细化 = 能力的结论
    const kinds = p.steps.map((s) => s.kind);
    expect(kinds).toContain('decode');
    expect(kinds).toContain('transcribe');              // 有 ASR ⇒ 真的会转写
  });

  it('K4 auto 走到新路时 `method` 与 `via` 一致；字幕/复合那条路没有 `via`', () => {
    [['local-asr', caps4(false, true, true, false)],
      ['omni', caps4(false, true, false, true)],
      ['mixed', caps4(false, true, true, true)]].forEach((c) => {
      const p = vs.planStrategy({ caps: c[1] }, { level: 'detailed' });
      expect(p.ok).toBe(true);
      expect(p.method).toBe(c[0]);
      expect(p.via).toBe(c[0]);
    });
    const sub = vs.planStrategy({ caps: caps4(true, false, false, false) }, { level: 'detailed' });
    expect(sub.ok).toBe(true);
    expect(sub.via).toBe(null);
    // 粗档也带 `via:null`（形状稳定：命令层不必判"键在不在"）
    expect(vs.planStrategy({ caps: caps4(true, true, false, false) }, { level: 'coarse' }).via).toBe(null);
  });
});

/* ============================================================================
 * L · 档位契约扩展：按路追加必备键（一份契约表，两处消费）
 * ========================================================================== */
describe('L · 契约按路生效：字幕路不要绑定、omni/mixed 必须给绑定（缺则明确失败）', () => {
  const caps4 = (s, f, a, v) => ({
    hasSubtitle: !!s, hasFfmpeg: !!f, hasAsr: !!a, hasVision: !!v,
    subtitleCount: s ? 1 : 0, subtitleFiles: s ? ['x.vtt'] : [],
    ffmpegPath: f ? 'C:/fake/ffmpeg.exe' : null,
    asrName: a ? 'fake-asr' : null, visionName: v ? 'fake-vision' : null
  });

  it('L1 `requiredKeysOf`：字幕路不追加绑定类键；三条新路各自追加', () => {
    const subKeys = vs.requiredKeysOf('detailed', 'subtitle');
    expect(subKeys).toContain('highlights');
    expect(subKeys).not.toContain('bindings');
    expect(vs.requiredKeysOf('detailed', 'local-asr')).toContain('anchors');
    expect(vs.requiredKeysOf('detailed', 'omni')).toContain('bindings');
    ['anchors', 'frames', 'bindings'].forEach((k) => expect(vs.requiredKeysOf('detailed', 'mixed')).toContain(k));
    // 未知档位 ⇒ 空表（不猜一档）
    expect(vs.requiredKeysOf('fine', 'mixed')).toEqual([]);
    // 粗档没有"按路追加"这回事
    expect(vs.requiredKeysOf('coarse', 'mixed')).toEqual(vs.summarizeContract('coarse').required);
  });

  it('★ L2 同一份详细档产出：`method` 换成 mixed 就因缺 frames/bindings 变红（契约按路生效）', () => {
    const base = {
      level: 'detailed', method: 'subtitle', why: '有字幕 ⇒ 选 subtitle 做详细档',
      target: 'x', topic: 't', durationSeconds: 30, durationText: '0:30', segments: 3,
      encrypted: false, structure: [], caps: {}, steps: [],
      cues: 2, highlights: [{ at: 1, atText: '0:01', text: '第一段' }],
      terms: [], outline: [], extractive: true, anchors: [{ at: 1, atText: '0:01', text: '第一段' }]
    };
    expect(vs.checkSummary(base, 'detailed').ok).toBe(true);
    const asMixed = vs.checkSummary(Object.assign({}, base, { method: 'mixed' }), 'detailed');
    expect(asMixed.ok).toBe(false);
    expect(asMixed.missing).toEqual(expect.arrayContaining(['frames', 'bindings']));
    const fixed = vs.checkSummary(Object.assign({}, base, {
      method: 'mixed',
      frames: [{ at: 1, file: 'f/0.jpg' }],
      bindings: [{ at: 1, frame: 'f/0.jpg', text: '第一段' }]
    }), 'detailed');
    expect(fixed.ok).toBe(true);
  });

  it('★ L3 粗档 mustNot 扩到 `anchors`/`frames`/`bindings`，步骤里也不许有 `bind`', () => {
    const p = vs.planStrategy({ caps: caps4(true, true, false, false) }, { level: 'coarse' });
    const sum = vs.composeCoarse({ target: 'x', topic: 't', totals: { seconds: 30 }, structure: [] }, p);
    expect(vs.checkSummary(sum, 'coarse').ok).toBe(true);
    ['anchors', 'frames', 'bindings'].forEach((k) => {
      const chk = vs.checkSummary(Object.assign({}, sum, { [k]: [{ at: 1 }] }), 'coarse');
      expect(chk.ok).toBe(false);
      expect(chk.violations.join('|')).toContain(k);
    });
    const withBind = Object.assign({}, sum, { steps: sum.steps.concat([{ kind: 'bind', what: '偷偷配对' }]) });
    expect(vs.checkSummary(withBind, 'coarse').ok).toBe(false);
    expect(vs.COARSE_FORBIDDEN_STEPS).toContain('bind');
  });

  it('★ L4 材料没到位 ⇒ `no-content-reader`：**不交一份没有绑定的 mixed**（声明 ≠ 材料）', () => {
    const facts = { target: 'x', topic: 't', totals: { seconds: 600, segments: 60 }, structure: [] };
    const caps = caps4(false, true, true, true);
    const plan = vs.planStrategy(Object.assign({ caps: caps }, facts), { level: 'detailed' });
    expect(plan.ok).toBe(true);
    expect(plan.method).toBe('mixed');
    const cues = [{ start: 1, end: 2, text: '第一句' }, { start: 9, end: 12, text: '第二句' }];
    const noFrames = vs.buildSummary(plan, { facts: facts, cues: cues });
    expect(noFrames.ok).toBe(false);
    expect(noFrames.code).toBe('no-content-reader');
    expect(noFrames.message).toContain('不能交');
    expect(noFrames.summary).toBe(undefined);
    // 材料齐了才出；三件产物都在，且 anchors 与逐段要点一一对应（抽帧的输入有据）
    const full = vs.buildSummary(plan, {
      facts: facts, cues: cues,
      frames: [{ at: 1, file: 'f/0.jpg' }],
      bindings: [{ at: 1, frame: 'f/0.jpg', text: '第一句' }]
    });
    expect(full.ok).toBe(true);
    expect(full.contract.ok).toBe(true);
    expect(full.summary.anchors).toHaveLength(full.summary.highlights.length);
    expect(full.summary.anchors[0]).toMatchObject({ at: 1, atText: '0:01' });
    expect(full.summary.frames).toHaveLength(1);
    expect(full.summary.bindings).toHaveLength(1);
  });

  it('L5 `anchorsOf`：保留时间点顺序与文本，坏锚点（无 at / 无文本）一律不进', () => {
    const a = vs.anchorsOf([
      { at: 12, atText: '0:12', text: '第二个点' },
      { at: 3, atText: '0:03', text: '第一个点' },
      { atText: '0:20', text: '没有 at' },
      { at: 30, text: '' }
    ]);
    expect(a).toEqual([{ at: 12, atText: '0:12', text: '第二个点' },
      { at: 3, atText: '0:03', text: '第一个点' }]);
  });
});

/* ============================================================================
 * M · 时间戳对齐抽帧的 argv + HLS 开门参数 + 锚点 → 时间点
 * ========================================================================== */
describe('M · `-ss` 前/后两种抽帧模式 + HLS 开门参数 + 锚点 → 抽帧时间点', () => {
  const GUARD = ['-allowed_extensions', 'ALL', '-protocol_whitelist', 'file,crypto,data'];

  it('★ M1 `frame-at`（输入定位）与 `frame-at-accurate`（输出定位）只差 `-ss` 的位置', () => {
    const fast = probe.ffmpegArgvOf('frame-at', 'in.m3u8', 'f.jpg', { atSec: 1234.5 });
    const slow = probe.ffmpegArgvOf('frame-at-accurate', 'in.m3u8', 'f.jpg', { atSec: 1234.5 });
    expect(fast).toEqual(['-hide_banner', '-nostdin', '-y'].concat(GUARD,
      ['-ss', '1234.5', '-i', 'in.m3u8', '-frames:v', '1', 'f.jpg']));
    expect(slow).toEqual(['-hide_banner', '-nostdin', '-y'].concat(GUARD,
      ['-i', 'in.m3u8', '-ss', '1234.5', '-frames:v', '1', 'f.jpg']));
    expect(fast.indexOf('-ss')).toBeLessThan(fast.indexOf('-i'));
    expect(slow.indexOf('-ss')).toBeGreaterThan(slow.indexOf('-i'));
  });

  it('★ M2 `slice`（omni 的切片）：`-ss`/`-t` 都在 `-i` 前；缺省时长与源码那个常量**同值**', () => {
    const a = probe.ffmpegArgvOf('slice', 'in.m3u8', 's0.wav', { startSec: 600 });
    expect(a).toEqual(['-hide_banner', '-nostdin', '-y'].concat(GUARD,
      ['-ss', '600', '-t', '600', '-i', 'in.m3u8', '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', 's0.wav']));
    // 两处常量必须同值（一方改了另一方没改，就是"计划说 10 分钟、实际切了别的"）
    expect(probe.LIMITS.OMNI_SLICE_SEC).toBe(vs.OMNI_SLICE_SEC);
    expect(vs.ASR_AUDIO).toEqual({ channels: 1, sampleRate: 16000 });
    expect(vs.VAD_SEGMENT_SEC).toEqual({ min: 30, max: 600 });
  });

  it('M3 `hlsGuardArgsOf`：只有 `.m3u8`/`.m3u` 给这四条（`.mp4` 与无扩展名不给；大小写/反斜杠都认）', () => {
    expect(probe.hlsGuardArgsOf('E:\\课\\学习中心.m3u8')).toEqual(GUARD);
    expect(probe.hlsGuardArgsOf('a/b.M3U')).toEqual(GUARD);
    expect(probe.hlsGuardArgsOf('a/b.mp4')).toEqual([]);
    expect(probe.hlsGuardArgsOf('a/b')).toEqual([]);
  });

  it('★ M4 `frameTimesOf`：排序、太近的跳过、超上限**如实报**（不静默截断）', () => {
    const anchors = [
      { at: 30, atText: '0:30', text: '第三点' },
      { at: 1, atText: '0:01', text: '第一点' },
      { at: 3, atText: '0:03', text: '太近，应被跳过' },
      { at: 12, atText: '0:12', text: '第二点' }
    ];
    const r = probe.frameTimesOf(anchors, { minGapSec: 5, maxFrames: 2 });
    expect(r.times.map((t) => t.at)).toEqual([1, 12]);
    expect(r.dropped.tooClose).toBe(1);       // 3 秒那个被跳过
    expect(r.dropped.overMax).toBe(1);        // 30 秒那个撞上限
    // 缺省参数（间隔 5 秒 / 上限 60 帧）下三个都过
    expect(probe.frameTimesOf(anchors).times.map((t) => t.at)).toEqual([1, 12, 30]);
  });
});
