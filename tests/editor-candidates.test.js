/* ============================================================
 * tests/editor-candidates.test.js —— 「在编辑器里打开」判据的单元测试（vitest；**零 Electron**）
 * ------------------------------------------------------------
 * 锁住 `src/editor-candidates.js` 的六条判据（每条都要能被打红）：
 *   1 **跳行能力来自产品自己的 `--help`**（解析 `--goto`；解析不出来 ⇒ `open` 档，不假装能跳）
 *   2 **argv 是数组**（`['--goto', '<path>:<line>']`）——**绝不拼命令行字符串**（注入面）
 *   3 **无行号不编造**（不给 line ⇒ 只传文件路径，**不许**默认第 1 行）
 *   4 **用户偏好优先**、偏好失效**不静默**（`stalePreference` 如实带出）
 *   5 **两档不许混**（`jump` / `open`；URL scheme 一律 `open`，`jumped` 恒 false）
 *   6 **危险关联分档**（WScript = `block`、媒体播放器 = `block`、无关联 = `note`）
 *
 * ⭐ 本文件里那条 `--help` 原文是**本机 2026-10-16 实捕获的读数**（Cursor 3.24.18 / Trae CN 3.4.3 都有），
 *    不是从文档抄的 —— 它是"跳行能力有据"的凭据，改它等于改凭据，别顺手美化 ✗。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import C from '../src/editor-candidates.js';

/** 本机实测抓到的两行（逐字，来自 `cursor --help` / `trae-cn --help` 的 stdout）。 */
const HELP_WITH_GOTO = [
  'Cursor 3.24.18',
  '',
  'Usage: cursor.exe [options][paths...]',
  '',
  'Options',
  '  -d --diff <file> <file>                    Compare two files with each',
  '                                             other.',
  '  -g --goto <file:line[:character]>          Open a file at the path on the',
  '                                             specified line and character',
  '                                             position.',
  '  -r --reuse-window                          Force to open a file or folder in',
  '                                             an already opened window.',
  '  -h --help                                  Print usage.'
].join('\n');

const HELP_WITHOUT_GOTO = [
  'SomeOtherEditor 1.0.0',
  '',
  'Usage: someeditor.exe [options][paths...]',
  '',
  'Options',
  '  -n --new-window   Open a new window.',
  '  -h --help         Print usage.'
].join('\n');

describe('editor-candidates ① 跳行能力：读产品自己的 --help', () => {
  it('help 里有 --goto ⇒ jump 档，并带出语法与原文凭据', () => {
    const r = C.parseGotoSupport(HELP_WITH_GOTO);
    expect(r.ok).toBe(true);
    expect(r.syntax).toBe('<file:line[:character]>');
    expect(r.evidence).toContain('--goto');
  });

  it('help 里没有 --goto ⇒ **不许**判成能跳行（响亮给出 why）', () => {
    const r = C.parseGotoSupport(HELP_WITHOUT_GOTO);
    expect(r.ok).toBe(false);
    expect(r.why).not.toBe('');
  });

  it('help 为空/拿不到 ⇒ 也是 false + why（采不到真值≠通过）', () => {
    expect(C.parseGotoSupport('').ok).toBe(false);
    expect(C.parseGotoSupport(null).why).not.toBe('');
  });
});

describe('editor-candidates ② 参数是数组，不是命令行字符串', () => {
  const cand = { id: 'cursor', label: 'Cursor', tier: 'jump', cli: { file: 'C:\\x\\Cursor.exe', head: ['C:\\x\\cli.js'] } };

  it('带行号 ⇒ [--goto, <path>:<line>] 两元素数组', () => {
    const r = C.commandArguments(cand, 'C:\\p\\a.js', 12);
    expect(Array.isArray(r.args)).toBe(true);
    expect(r.args).toEqual(['--goto', 'C:\\p\\a.js:12']);
    expect(r.jumped).toBe(true);
  });

  it('带行号+列号 ⇒ 三截形态', () => {
    expect(C.commandArguments(cand, 'C:\\p\\a.js', 12, 7).args[1]).toBe('C:\\p\\a.js:12:7');
  });

  it('⭐ 路径里带 `&` / 空格 / 引号 ⇒ 仍是**一个** argv 元素（没有转义、没有拼接）', () => {
    const weird = 'C:\\p a & b\\"x"\\a.js';
    const r = C.commandArguments(cand, weird, 3);
    expect(r.args).toHaveLength(2);
    expect(r.args[1]).toBe(weird + ':3');
  });

  it('没有 CLI 的候选 ⇒ null（不当成"能跳"）', () => {
    expect(C.commandArguments({ id: 'x', tier: 'open', cli: null }, 'C:\\a.js', 3)).toBe(null);
  });
});

describe('editor-candidates ③ 行号口径：没有就不编', () => {
  it('0 / 负数 / NaN / 字符串垃圾 ⇒ null（**不是第 1 行**）', () => {
    expect(C.normalizeLine(0)).toBe(null);
    expect(C.normalizeLine(-3)).toBe(null);
    expect(C.normalizeLine(NaN)).toBe(null);
    expect(C.normalizeLine('abc')).toBe(null);
    expect(C.normalizeLine(undefined)).toBe(null);
  });

  it('12.7 ⇒ 12（取整而非四舍五入到 13：行号是**位置**不是度量）', () => {
    expect(C.normalizeLine(12.7)).toBe(12);
  });

  const cand = { id: 'cursor', label: 'Cursor', tier: 'jump', cli: { file: 'C:\\x\\Cursor.exe', head: [] } };
  it('不给行号 ⇒ 只传文件路径（不出现 --goto）', () => {
    const r = C.commandArguments(cand, 'C:\\p\\a.js', null);
    expect(r.args).toEqual(['C:\\p\\a.js']);
    expect(r.jumped).toBe(false);
  });
});

describe('editor-candidates ④ 选谁：偏好优先，失效不静默', () => {
  const A = { id: 'cursor', label: 'Cursor', tier: 'jump' };
  const B = { id: 'notepad', label: 'Notepad', tier: 'open' };
  const D = { id: 'trae-cn', label: 'Trae CN', tier: 'jump' };

  it('偏好命中且这次也探到 ⇒ 用它', () => {
    const r = C.choose([A, D], 'trae-cn');
    expect(r.candidate.id).toBe('trae-cn');
    expect(r.why).toBe('user-preference');
    expect(r.stalePreference).toBe(null);
  });

  it('没有偏好 ⇒ 先取 jump 档（能跳行 > 只能打开）', () => {
    expect(C.choose([B, D]).candidate.id).toBe('trae-cn');
  });

  it('只有 open 档 ⇒ 也用它，但 why 说明是 open', () => {
    const r = C.choose([B]);
    expect(r.candidate.id).toBe('notepad');
    expect(r.why).toBe('first-open');
  });

  it('⭐ 偏好失效（那个编辑器卸载了）⇒ 带 stalePreference 出来，**不假装没这回事**', () => {
    const r = C.choose([D], 'cursor');
    expect(r.candidate.id).toBe('trae-cn');
    expect(r.stalePreference).toBe('cursor');
    expect(r.why).toBe('preference-gone-jump-first');
  });

  it('一个都没探到 ⇒ candidate=null（出口据此**响亮降级**）', () => {
    const r = C.choose([], 'cursor');
    expect(r.candidate).toBe(null);
    expect(r.why).toBe('preference-gone-nothing-detected');
  });
});

describe('editor-candidates ⑤ 两档与 URL scheme', () => {
  it('URL scheme 目标**恒不声称跳行**（jumped=false）', () => {
    const r = C.schemeTarget({ id: 'cursor', scheme: 'cursor', tier: 'open' }, 'C:\\p\\a.js', 12, 3);
    expect(r.url).toBe('cursor://file/C:/p/a.js:12:3');
    expect(r.jumped).toBe(false);
  });

  it('没有 scheme 的候选 ⇒ null', () => {
    expect(C.schemeTarget({ id: 'sublime', scheme: '' }, 'C:\\p\\a.js', 1)).toBe(null);
  });

  it('档位文案只在 TIER_TEXT 一处（界面只显示、不自拼）', () => {
    expect(C.TIER_TEXT.jump).toContain('跳');
    expect(C.TIER_TEXT.open).toContain('只能打开');
    const rows = C.summarize([{ id: 'cursor', label: 'Cursor', tier: 'jump', via: 'cli', found: 'path' }]);
    expect(rows[0].label).toContain(C.TIER_TEXT.jump);
    expect(rows[0].tierText).toBe(C.TIER_TEXT.jump);
  });
});

describe('editor-candidates ⑥ 扩展名关联的危害分档（第 3 件的判据）', () => {
  it('WScript ⇒ exec 档 + block 级（**不许把它交出去**）', () => {
    const code = C.assocHazard('C:\\Windows\\System32\\WScript.exe "%1" %*');
    expect(code).toBe('assoc-exec');
    expect(C.hazardLevel(code)).toBe('block');
    expect(C.hazardText(code)).toContain('执行');
  });

  it('媒体播放器（.ts 的实测去向）⇒ media 档 + block 级', () => {
    // Windows Media Player 的实测形态（`ftype WMP11.AssocFile.TTS`）
    const code = C.assocHazard('"%ProgramFiles(x86)%\\Windows Media Player\\wmplayer.exe" /prefetch:12 /Open "%L"', 'WMP11.AssocFile.TTS');
    expect(code).toBe('assoc-media');
    expect(C.hazardLevel(code)).toBe('block');
  });

  it('⭐ ProgId 是**应用抢注的媒体类型** ⇒ 也判 media（本机 .ts → PotPlayer 实测形态）', () => {
    // 第一版只认 wmplayer.exe ⇒ 这条必红（漏判）。判据改成"形状"后才守得住。
    const code = C.assocHazard('"C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe" "%1"', 'PotPlayerMini64.TS');
    expect(code).toBe('assoc-media');
  });

  it('ProgId 带 `AssocFile` 前缀（Windows 媒体关联的命名形状）⇒ media', () => {
    expect(C.assocHazard('C:\\x\\player.exe "%1"', 'WMP11.AssocFile.MP3')).toBe('assoc-media');
  });

  it('没有关联 ⇒ 由探测侧记 assoc-none（note 档：放行，但要说）', () => {
    expect(C.assocHazard('', '')).toBe('');
    expect(C.hazardLevel('assoc-none')).toBe('note');
    expect(C.hazardText('assoc-none')).not.toBe('');
  });

  it('普通应用（记事本 / IE）⇒ 无危害码（安静放行）', () => {
    expect(C.assocHazard('%SystemRoot%\\system32\\NOTEPAD.EXE %1', 'txtfile')).toBe('');
    expect(C.assocHazard('"C:\\Program Files\\Internet Explorer\\iexplore.exe" %1', 'htmlfile')).toBe('');
    expect(C.hazardLevel('')).toBe('');
  });
});

describe('editor-candidates ⑦ 从注册表命令行反查（探测侧的输入形态）', () => {
  it('带引号的命令行 ⇒ 取第一个引号组当 exe', () => {
    expect(C.exePathFromCommand('"D:\\Program Files\\Trae CN\\Trae CN.exe" "--open-url" "--" "%1"'))
      .toBe('D:\\Program Files\\Trae CN\\Trae CN.exe');
  });

  it('不带引号 ⇒ 取到 .exe 为止', () => {
    expect(C.exePathFromCommand('C:\\x\\cursor.exe --open-url "%1"')).toBe('C:\\x\\cursor.exe');
  });

  it('⭐ 不带引号**但路径里有空格**（App Paths 的真实形态）⇒ 也要解出来', () => {
    expect(C.exePathFromCommand('C:\\Program Files\\Microsoft VS Code\\Code.exe'))
      .toBe('C:\\Program Files\\Microsoft VS Code\\Code.exe');
    expect(C.exePathFromCommand('C:\\Program Files\\X\\Code.exe -n'))
      .toBe('C:\\Program Files\\X\\Code.exe');
  });

  it('exe 名 → catalog 项（大小写不敏感）', () => {
    expect(C.byExeName('D:\\x\\TRAE CN.EXE').id).toBe('trae-cn');
    expect(C.byExeName('nope.exe')).toBe(null);
  });

  it('安装布局：`bin\\<cli>.cmd` 与 `resources\\app\\out\\cli.js` 都从 exe 反推', () => {
    const L = C.layoutOf('D:\\Program Files\\Trae CN\\Trae CN.exe', ['trae-cn']);
    expect(L.binCmd).toContain('D:\\Program Files\\Trae CN\\bin\\trae-cn.cmd');
    expect(L.cliJs).toBe('D:\\Program Files\\Trae CN\\resources\\app\\out\\cli.js');
  });
});
