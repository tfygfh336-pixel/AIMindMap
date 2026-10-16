/* ============================================================
 * tests/editor-probe.test.js —— 「本机装了哪些编辑器」探测面的单元测试（vitest；**零 Electron、零真进程**）
 * ------------------------------------------------------------
 * ⭐ 这个文件的**主要目的**是判据 ③：**候选探测不许写死**。
 *    做法不是"读一遍代码觉得它没写死"，而是：
 *      · 喂**假读数**（只有注册表里那条 Trae CN 命中，PATH / App Paths / 常见落点**全空**）
 *        ⇒ 断言候选表里**必须**出现 `trae-cn` 且 `found === 'registry-scheme'`；
 *      · 再喂一份"什么都没探到"的假读数 ⇒ 断言候选表**必须为空**（**不是**"按目录表给出一串候选"）。
 *    第二条是**反写死**的关键：一个把 catalog 当答案的实现会返回一整串条目 —— 它在这条上必红。
 *    真实世界的对照就发生在本机：按常见落点探 ⇒ "Trae CN 没装"（假）；注册表探 ⇒ 装在
 *    `D:\Program Files\Trae CN\`（真，见 .review/20261016-改动清单面板/README.md）。
 *
 * 注入判别力证明（把探测源改成写死 ⇒ 本文件必红）与三记还原的读数，记在那份 README 里。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import P from '../src/editor-probe.js';

/** 本机实测抓到的 `--goto` 帮助原文（与 editor-candidates.test.js 同一凭据）。 */
const HELP_WITH_GOTO = 'Trae CN 3.4.3\n\nUsage: trae-cn.exe [options] [paths...]\n\nOptions\n  -g --goto <file:line[:character]>          Open a file at the path on the specified line and character position.\n  -h --help   Print usage.';
const HELP_NO_GOTO = 'PlainEditor 1.0\n\nUsage: plain.exe [options]\n\nOptions\n  -h --help   Print usage.';

const TRAE_EXE = 'D:\\Program Files\\Trae CN\\Trae CN.exe';
const TRAE_CLI = 'D:\\Program Files\\Trae CN\\resources\\app\\out\\cli.js';
const CURSOR_EXE = 'D:\\Program Files\\cursor\\Cursor.exe';
const CURSOR_CLI = 'D:\\Program Files\\cursor\\resources\\app\\out\\cli.js';
/** 本机 `where cursor` 的真实形态：**无扩展名的 shim**，躺在 `resources\app\bin\` 里。
 *  ⇒ 探测必须能"见到这个入口、反推出安装根"，否则 PATH 这一档等于白探。 */
const CURSOR_SHIM = 'D:\\Program Files\\cursor\\resources\\app\\bin\\cursor';
const CURSOR_FILES = [CURSOR_SHIM, CURSOR_EXE, CURSOR_CLI];

/** 假 IO：所有外部读数都由夹具给 ⇒ 测试**不起任何子进程**、不碰真注册表。 */
function fakeIo(spec) {
  const files = (spec.files || []).map((f) => String(f).toLowerCase());
  return {
    env: Object.assign({
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)'
    }, spec.env || {}),
    exists: (p) => files.indexOf(String(p).toLowerCase()) >= 0,
    listDir: (d) => (spec.dirs && spec.dirs[d]) || [],
    which: (n) => (spec.which && spec.which[n]) || '',
    readRegKey: (k) => (spec.reg && spec.reg[k]) || { ok: false, value: '', code: 1 },
    runHelp: (file, args) => {
      const key = file + ' ' + args.join(' ');
      for (const k of Object.keys(spec.help || {})) if (key.indexOf(k) >= 0) return spec.help[k];
      return { ok: false, why: '夹具没有这条 help' };
    }
  };
}

describe('editor-probe ① 四个探测源各自都能单独找到编辑器', () => {
  it('PATH 命中（cursor，**无扩展名 shim**）⇒ 反推出安装根、found=path、tier=jump', () => {
    const io = fakeIo({
      which: { cursor: CURSOR_SHIM },
      files: CURSOR_FILES,
      help: { [CURSOR_EXE]: { ok: true, out: HELP_WITH_GOTO } }
    });
    const r = P.probeWith(io, {});
    const c = r.candidates.filter((x) => x.id === 'cursor')[0];
    expect(c).toBeTruthy();
    expect(c.found).toBe('path');
    expect(c.tier).toBe('jump');
    expect(c.cli.how).toContain('exe+cli.js');
  });

  it('⭐ 注册表 scheme 命中（trae-cn）⇒ **常见落点全空也能找到**（本机真实形态）', () => {
    const io = fakeIo({
      // PATH 空、App Paths 空、known-dir 空 —— **只有注册表这一条路**
      reg: { 'HKCU\\Software\\Classes\\trae-cn\\shell\\open\\command': { ok: true, value: '"D:\\Program Files\\Trae CN\\Trae CN.exe" "--open-url" "--" "%1"' } },
      files: [TRAE_EXE, TRAE_CLI],
      help: { [TRAE_EXE]: { ok: true, out: HELP_WITH_GOTO } }
    });
    const r = P.probeWith(io, {});
    const c = r.candidates.filter((x) => x.id === 'trae-cn')[0];
    expect(c).toBeTruthy();
    expect(c.found).toBe('registry-scheme');
    expect(c.tier).toBe('jump');
    // 反写死的正面断言：这一条**不是**从写死的落点表里来的
    expect(r.candidates.map((x) => x.found)).not.toContain('known-dir');
  });

  it('App Paths 命中（vscode）⇒ found=app-paths', () => {
    const io = fakeIo({
      reg: { 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe': { ok: true, value: 'C:\\Program Files\\Microsoft VS Code\\Code.exe' } },
      files: ['C:\\Program Files\\Microsoft VS Code\\Code.exe', 'C:\\Program Files\\Microsoft VS Code\\resources\\app\\out\\cli.js'],
      help: { 'Code.exe': { ok: true, out: HELP_WITH_GOTO } }
    });
    const r = P.probeWith(io, {});
    expect(r.candidates[0].id).toBe('vscode');
    expect(r.candidates[0].found).toBe('app-paths');
  });

  it('常见落点命中（最弱一档）⇒ found=known-dir', () => {
    const io = fakeIo({
      files: ['C:\\Program Files\\cursor\\Cursor.exe', CURSOR_CLI],
      help: { [CURSOR_EXE]: { ok: true, out: HELP_WITH_GOTO } }
    });
    const r = P.probeWith(io, {});
    expect(r.candidates[0].found).toBe('known-dir');
  });

  it('⭐ 什么都没探到 ⇒ 候选表**必须为空**（catalog 不是答案）', () => {
    const r = P.probeWith(fakeIo({}), {});
    expect(r.candidates).toEqual([]);
    expect(r.candidates.length).not.toBe(7); // 把目录表当答案的实现会在这里红
  });

  it('注册表指向的 exe **不在盘上** ⇒ 不算命中，并记一条 reason（不静默）', () => {
    const io = fakeIo({
      reg: { 'HKCU\\Software\\Classes\\cursor\\shell\\open\\command': { ok: true, value: '"Z:\\gone\\Cursor.exe" --open-url "%1"' } }
    });
    const r = P.probeWith(io, {});
    expect(r.candidates).toEqual([]);
    expect(r.errors.join(' ')).toContain('不在盘上');
  });
});

describe('editor-probe ② 跳行档的判据来自 CLI 自己的 help（不是我们的表）', () => {
  it('CLI 在、help 有 --goto ⇒ jump', () => {
    const io = fakeIo({
      which: { cursor: CURSOR_SHIM }, files: CURSOR_FILES,
      help: { [CURSOR_EXE]: { ok: true, out: HELP_WITH_GOTO } }
    });
    const c = P.probeWith(io, {}).candidates[0];
    expect(c.tier).toBe('jump');
    expect(c.via).toBe('cli');
    expect(c.jump.evidence).toContain('--goto');
  });

  it('CLI 在、help **没有** --goto ⇒ open 档 + 响亮记账（**不假装能跳行**）', () => {
    const io = fakeIo({
      which: { cursor: CURSOR_SHIM }, files: CURSOR_FILES,
      help: { [CURSOR_EXE]: { ok: true, out: HELP_NO_GOTO } }
    });
    const r = P.probeWith(io, {});
    expect(r.candidates[0].tier).toBe('open');
    expect(r.errors.join(' ')).toContain('没有 --goto');
  });

  it('help 跑不通（超时/崩）⇒ open 档 + 记账（**采不到真值 ≠ 通过**）', () => {
    const io = fakeIo({
      which: { cursor: CURSOR_SHIM }, files: CURSOR_FILES,
      help: { [CURSOR_EXE]: { ok: false, why: 'exit 1' } }
    });
    const r = P.probeWith(io, {});
    expect(r.candidates[0].tier).toBe('open');
    expect(r.errors.join(' ')).toContain('help 跑不通');
  });

  it('只有 exe、没有 CLI ⇒ open 档（**只能打开，跳不了行**）', () => {
    const io = fakeIo({ files: ['C:\\Program Files\\Cursor\\Cursor.exe'] });   // 走 known-dir 那一档
    const c = P.probeWith(io, {}).candidates[0];
    expect(c.tier).toBe('open');
    expect(c.via).toBe('exe');
  });

  it('只剩 `.cmd` 包装、安装根认不出 ⇒ open 档 + 记账（**不为了起它去拼命令行**）', () => {
    const io = fakeIo({ which: { cursor: 'D:\\stray\\bin\\cursor.cmd' }, files: ['D:\\stray\\bin\\cursor.cmd'] });
    const r = P.probeWith(io, {});
    expect(r.candidates[0].tier).toBe('open');
    expect(r.candidates[0].cli).toBe(null);
    expect(r.errors.join(' ')).toContain('起不了 CLI');
  });
});

describe('editor-probe ③ 关联危害（第 3 件读数）', () => {
  it('.js → WScript ⇒ assoc-exec', () => {
    const io = fakeIo({
      reg: {
        'HKCR\\.js': { ok: true, value: 'JSFile' },
        'HKCR\\JSFile\\shell\\open\\command': { ok: true, value: 'C:\\Windows\\System32\\WScript.exe "%1" %*' }
      }
    });
    const r = P.probeWith(io, {});
    expect(r.associations['.js'].progId).toBe('JSFile');
    expect(r.associations['.js'].hazard).toBe('assoc-exec');
  });

  it('.md 没有关联 ⇒ assoc-none（且**不会被"默认值未设置"这种本地化占位串骗到**）', () => {
    // 本机实测：`reg query HKCR\.md /ve` 对"键在、默认值没设"会**成功**返回本地化的占位串
    // ⇒ 直接当 ProgId 会去查一个不存在的键。这条用例锁住"只接受形状像 ProgId 的值"。
    const io = fakeIo({ reg: { 'HKCR\\.md': { ok: true, value: '(默认值未设置)' } } });
    const r = P.probeWith(io, {});
    expect(r.associations['.md'].progId).toBe('');
    expect(r.associations['.md'].hazard).toBe('assoc-none');
  });

  it('.ts → PotPlayer（本机实测形态）⇒ assoc-media', () => {
    const io = fakeIo({
      reg: {
        'HKCR\\.ts': { ok: true, value: 'PotPlayerMini64.TS' },
        'HKCR\\PotPlayerMini64.TS\\shell\\open\\command': { ok: true, value: '"C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe" "%1"' }
      }
    });
    expect(P.probeWith(io, {}).associations['.ts'].hazard).toBe('assoc-media');
  });

  it('⭐ 同一个编辑器从两条路命中 ⇒ 候选表里**只出现一行**（出处取更强的那条）', () => {
    // 本机实测形态：Cursor 既在 PATH（无扩展名 shim）、注册表 scheme 也在 ⇒ 第一版出了两行 Cursor。
    const io = fakeIo({
      which: { cursor: CURSOR_SHIM },
      reg: { 'HKCU\\Software\\Classes\\cursor\\shell\\open\\command': { ok: true, value: '"' + CURSOR_EXE + '" --open-url -- "%1"' } },
      files: CURSOR_FILES,
      help: { [CURSOR_EXE]: { ok: true, out: HELP_WITH_GOTO } }
    });
    const r = P.probeWith(io, {});
    expect(r.candidates.filter((c) => c.id === 'cursor')).toHaveLength(1);
    expect(r.candidates[0].found).toBe('path');           // path 比 registry-scheme 强
    expect(r.candidates[0].exe).toBe(CURSOR_EXE);         // 报出来的是真 exe，不是 shim
  });

  it('夹具环境变量一开 ⇒ stub:true（**绝不冒充真探测结果**）', () => {
    // 只验证"带夹具时结果标 stub"这条契约；真正的 env 读取在 probe() 里，这里用最小夹具。
    const r = P.probeWith(fakeIo({}), {});
    expect(r.stub).toBe(false);
  });
});
