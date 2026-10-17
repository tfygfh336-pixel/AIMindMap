/* ============================================================
 * tests/path-chain.test.js — 「路径 → 打开 / 预览」判据的单元测试（vitest，**零 Electron**）
 * ------------------------------------------------------------
 * 锁住 `src/path-chain.js` 的六条判据（每条都要能被注入打红）：
 *   1 **禁 `..` 逃逸**（规范化后必须仍在当前项目目录之内）
 *   2 **禁 UNC / 设备路径**（`\\?\`、`\\.\`、`\\server\share`、`//host/share`）—— 且**零 I/O**
 *   3 **打不开必须显式报错**（每条 reject 的 `reason` 非空、且等于 `REASONS[code]` 这一份文案）
 *   4 **`localPath` 单开一档**（工作区外的绝对路径照样开；只校验形状，不校验存在性）
 *   5 **`action` 与改动前逐条等价或更严**（绝不更松；产物字节与改动前算式相同）
 *   6 **`http(s)` 只放行、别的协议一律拒**（`externalUrl` 档 —— 外部链接出口批新增）
 * 外加三条**结构断言**（"只有一处实现"）：
 *   · 渲染层不再自己拼路径 / 不再自己判"能不能开"；
 *   · 判据的 `code`（一律带 `path-` 前缀）只在 `src/path-chain.js` 里出现；
 *   · 本模块**零 I/O**（没有 `require`、没有 `fs.` —— 判据不许对网络盘做存在性探测）。
 * 最后一条：与**改动前那几行**（oracle）的等价性由 `scripts/pathchain-conformance.js` 的合成样本复核
 *   （真实语料的全量对拍读数见 `.review/20261016-路径链抽取/README.md`；那条不进单测 ——
 *   它的输入是活的 `projects/**`，同一时刻工作区与 git HEAD 就是两个真值）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  decide, rendererUrlOf, projectDirOf, REASONS, KINDS, ACTIONS, PREVIEW_EXTS,
  EXIT_KINDS, ALLOWED_URL_PROTOCOLS
} from '../src/path-chain.js';
import conformance from '../scripts/pathchain-conformance.js';

const ROOT = path.resolve(__dirname, '..');
const PROJECT = { file: 'D:\\zz\\projects\\demo\\demo.json', name: 'demo' };
const JUDGE = (kind, raw, project = PROJECT, force) => decide({ kind, raw, project, force });
/** 判据 code 一律带这个前缀（避免与别处无关的状态串撞名 ⇒ 结构断言才立得住） */
const CODE_PREFIX = 'path-';

/** 剥注释（结构断言用；只求"代码里有没有"，不求精确的语法分析） */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('path-chain ① 解析与产物（与改动前的算式逐字节相同）', () => {
  it('项目 JSON 的绝对路径 → 项目目录（唯一一处）', () => {
    expect(projectDirOf('D:\\zz\\projects\\demo\\demo.json')).toBe('D:\\zz\\projects\\demo');
    expect(projectDirOf('D:/zz/projects/demo/demo.json')).toBe('D:/zz/projects/demo');
  });

  it('附件：abs = 项目目录 + "/" + 原文（与改动前 `base + "/" + rel` 逐字相同）', () => {
    const d = JUDGE('attachment', 'attachments/20261016 中文 附件 (1).pdf');
    expect(d.ok).toBe(true);
    expect(d.abs).toBe('D:\\zz\\projects\\demo/attachments/20261016 中文 附件 (1).pdf');
    expect(d.action).toBe('preview');
  });

  it('图片：页面相对地址与改动前那一行逐字相同（串只在模块里拼）', () => {
    expect(rendererUrlOf(PROJECT, 'assets/图 1.png')).toBe('../projects/demo/assets/图 1.png');
    expect(rendererUrlOf(null, 'assets/a.png')).toBe('assets/a.png');
    const d = JUDGE('image', 'assets/图 1.png');
    expect(d.ok).toBe(true);
    expect(d.action).toBe('preview');
  });

  it('反斜杠分隔也认（Node 与 Chromium 两种都吃，改动前同样能开）', () => {
    const d = JUDGE('attachment', 'attachments\\子目录\\x.txt');
    expect(d.ok).toBe(true);
    expect(d.action).toBe('system');
  });
});

describe('path-chain 判据 1：禁 .. 逃逸', () => {
  it('逃出项目目录 ⇒ reject + code=path-escape + reason 非空', () => {
    for (const raw of [
      'attachments/../../config.json',
      '../../../../Windows/win.ini',
      'a/b/../../../..',
      'assets/../../../comnet.json'
    ]) {
      const d = JUDGE('attachment', raw);
      expect(d.ok, raw).toBe(false);
      expect(d.code, raw).toBe(CODE_PREFIX + 'escape');
      expect(d.abs, raw).toBeNull();
      expect(d.action, raw).toBe('reject');
      expect(d.reason.length, raw).toBeGreaterThan(0);
    }
  });

  it('图片路径同样判（图片区改前是一颗静默裂图）', () => {
    const d = JUDGE('image', 'assets/../../comnet.json');
    expect(d.ok).toBe(false);
    expect(d.code).toBe(CODE_PREFIX + 'escape');
  });

  it('**不逃逸**的 .. 照旧放行（比如 assets/../attachments/a.pdf 落在项目内）', () => {
    const d = JUDGE('attachment', 'assets/../attachments/a.pdf');
    expect(d.ok).toBe(true);
    expect(d.action).toBe('preview');
  });

  it('解析结果 = 项目目录本身（assets/..）⇒ reject（它不是一份文件）', () => {
    const d = JUDGE('attachment', 'assets/..');
    expect(d.ok).toBe(false);
    expect(d.code).toBe(CODE_PREFIX + 'self');
  });

  it('绝对路径 / 前导斜杠 / 盘符 不许当相对路径', () => {
    for (const raw of ['C:/Windows/win.ini', '/etc/passwd', '\\Windows\\win.ini', 'C:']) {
      const d = JUDGE('attachment', raw);
      expect(d.ok, raw).toBe(false);
      expect([CODE_PREFIX + 'not-relative', CODE_PREFIX + 'unc-device'], raw).toContain(d.code);
    }
  });
});

describe('path-chain 判据 2：禁 UNC / 设备路径（只按形状，零 I/O）', () => {
  it('四种形状一律 reject', () => {
    for (const raw of ['\\\\?\\C:\\Windows\\win.ini', '\\\\.\\PhysicalDrive0', '\\\\NAS\\share\\x.pdf', '//host/share/x']) {
      const d = JUDGE('attachment', raw);
      expect(d.ok, raw).toBe(false);
      expect(d.code, raw).toBe(CODE_PREFIX + 'unc-device');
      expect(d.reason.length, raw).toBeGreaterThan(0);
    }
  });

  it('`localPath` / 出口档（system）也拒 UNC 与设备路径', () => {
    for (const raw of ['\\\\?\\E:\\markdown', '\\\\NAS\\share\\资料', '//NAS/share']) {
      expect(JUDGE('localPath', raw).code, raw).toBe(CODE_PREFIX + 'unc-device');
      expect(JUDGE('system', raw).code, raw).toBe(CODE_PREFIX + 'unc-device');
    }
  });

  it('判据**零 I/O**：模块源码里没有 require / fs.* （"不探存在性"是结构保证，不是自觉）', () => {
    const src = stripComments(readFileSync(path.join(ROOT, 'src/path-chain.js'), 'utf8'));
    for (const bad of ['require(', 'existsSync', 'statSync', 'readFileSync', 'writeFileSync', 'fs.']) {
      expect(src.indexOf(bad), '不该出现：' + bad).toBe(-1);
    }
  });
});

describe('path-chain 判据 3：打不开必须显式报错（reason 非空且文案单源）', () => {
  it('所有 reject 都带非空 reason，且 reason === REASONS[code]', () => {
    const bad = [
      ['attachment', undefined], ['attachment', null], ['attachment', 42], ['attachment', ''], ['attachment', '   '],
      ['attachment', 'a\u0000b'], ['attachment', 'a\nb'], ['attachment', '\\\\?\\C:\\x'],
      ['attachment', '../../x'], ['attachment', 'C:/x'], ['attachment', 'assets/..'],
      ['image', 'assets/../../x.png'], ['localPath', 'rel/path'], ['localPath', '\\\\NAS\\s'],
      ['system', 'rel'], ['nope', 'x']
    ];
    for (const [kind, raw] of bad) {
      const d = JUDGE(kind, raw);
      expect(d.ok, kind + ' ' + String(raw)).toBe(false);
      expect(d.action, kind + ' ' + String(raw)).toBe('reject');
      expect(d.abs, kind + ' ' + String(raw)).toBeNull();
      expect(d.reason.length, kind + ' ' + String(raw)).toBeGreaterThan(0);
      expect(d.reason).toBe(REASONS[d.code]);          // 文案只有一处（模块里的 REASONS）
      expect(d.code.indexOf(CODE_PREFIX)).toBe(0);      // code 一律带前缀（撞名会破坏结构断言）
    }
  });

  it('没有项目路径时，相对路径类 reject（不是静默返回 null）', () => {
    for (const p of [null, {}, { file: '' }, { file: '   ' }]) {
      const d = decide({ kind: 'attachment', raw: 'attachments/a.pdf', project: p });
      expect(d.ok).toBe(false);
      expect(d.code).toBe(CODE_PREFIX + 'no-project');
      expect(d.reason.length).toBeGreaterThan(0);
    }
  });

  it('乱输入不抛错（永远返回同一个形状）', () => {
    for (const input of [undefined, null, {}, [], 'x', 7, { kind: 'attachment' }, { raw: 'a' }]) {
      const d = decide(input);
      expect(typeof d.ok).toBe('boolean');
      expect(d.ok).toBe(false);
      expect(d.reason.length).toBeGreaterThan(0);
      expect(KINDS).toContain(input && input.kind ? input.kind : 'attachment');
    }
  });
});

describe('path-chain 判据 4：localPath 单开一档（工作区外照样开）', () => {
  it('正常形态：工作区外的绝对路径 ⇒ **必须 accept**（拿"在项目内"卡它就是砸掉既有功能）', () => {
    for (const raw of ['E:\\markdown\\M1', 'D:\\随便\\一个 目录（中文）', 'C:\\Users\\x\\我的笔记 2026']) {
      const d = JUDGE('localPath', raw);
      expect(d.ok, raw).toBe(true);
      expect(d.action, raw).toBe('system');
      expect(d.abs, raw).toBe(raw);                    // 原样交出口（不许规范化改写它）
    }
  });

  it('只校验形状：相对路径 / 空 / 换行 / 超 500 字符 都拒', () => {
    expect(JUDGE('localPath', 'markdown/M1').code).toBe(CODE_PREFIX + 'not-absolute');
    expect(JUDGE('localPath', '').code).toBe(CODE_PREFIX + 'empty');
    expect(JUDGE('localPath', 'E:\\a\nb').code).toBe(CODE_PREFIX + 'control-char');
    const ok500 = 'E:\\' + 'x'.repeat(497);            // 长度恰好 500
    expect(ok500.length).toBe(500);
    expect(JUDGE('localPath', ok500).ok).toBe(true);
    expect(JUDGE('localPath', ok500 + 'x').code).toBe(CODE_PREFIX + 'too-long');
  });

  it('**不校验存在性**：盘没挂 / 目录不存在也照旧 accept（改前同样如此）', () => {
    const d = JUDGE('localPath', 'Z:\\这台机器上不存在的盘\\不存在的目录');
    expect(d.ok).toBe(true);
    expect(d.action).toBe('system');
  });
});

describe('path-chain 判据 5：action 三档与改动前等价或更严', () => {
  it('附件：md/markdown/pdf 进内预览，其余交系统（与改动前 openFilePreview 的分档同一条）', () => {
    expect(JUDGE('attachment', 'attachments/a.md').action).toBe('preview');
    expect(JUDGE('attachment', 'attachments/a.MARKDOWN').action).toBe('preview');
    expect(JUDGE('attachment', 'attachments/a.PDF').action).toBe('preview');
    expect(JUDGE('attachment', 'attachments/a.zip').action).toBe('system');
    expect(JUDGE('attachment', 'attachments/noext').action).toBe('system');
    expect(PREVIEW_EXTS).toEqual(['md', 'markdown', 'pdf']);
  });

  it('图片恒内预览；localPath / system 恒交系统', () => {
    expect(JUDGE('image', 'assets/a.bmp').action).toBe('preview');
    expect(JUDGE('localPath', 'E:\\m').action).toBe('system');
    expect(JUDGE('system', 'E:\\m\\x.pdf').action).toBe('system');
  });

  it('force=system 只把 preview 改判 system，**压不过 reject**（不是一条更松的口子）', () => {
    expect(JUDGE('attachment', 'attachments/a.pdf', PROJECT, 'system').action).toBe('system');
    const rej = JUDGE('attachment', '../../x.pdf', PROJECT, 'system');
    expect(rej.ok).toBe(false);
    expect(rej.action).toBe('reject');
  });

  it('取值表是闭环：KINDS / ACTIONS 就是文档里那两串', () => {
    expect(KINDS).toEqual(['attachment', 'image', 'inline', 'localPath', 'system', 'externalUrl']);
    expect(ACTIONS).toEqual(['preview', 'system', 'external', 'reject']);
    expect(JUDGE('inline', 'attachments/a.md').action).toBe('preview');   // R7 的正文路径档，本批已备好
    expect(JUDGE('nope', 'x').code).toBe(CODE_PREFIX + 'unknown-kind');
  });

  it('出口那一侧的取值表也只有一份：`EXIT_KINDS` = 两条腿，且都在 `KINDS` 里', () => {
    expect(EXIT_KINDS).toEqual(['system', 'externalUrl']);
    for (const k of EXIT_KINDS) expect(KINDS, k).toContain(k);
  });

  it('纯函数：同输入同输出、不改入参（冻结对象下也不抛）', () => {
    const input = Object.freeze({ kind: 'attachment', raw: 'attachments/a.pdf', project: Object.freeze(PROJECT) });
    const a = decide(input);
    const b = decide(input);
    expect(a).toEqual(b);
    expect(input.raw).toBe('attachments/a.pdf');
  });
});

describe('path-chain 判据 6：`http(s)` 只放行、别的协议一律拒（`externalUrl` 档）', () => {
  it('合法 http / https ⇒ ok + `action` 为 external + `abs = new URL(raw).href`（判的那份就是交出去的那份）', () => {
    for (const raw of ['http://example.com/a?b=1', 'https://example.com', 'https://例子.com/中文']) {
      const d = JUDGE('externalUrl', raw);
      expect(d.ok, raw).toBe(true);
      expect(d.action, raw).toBe('external');
      expect(d.abs, raw).toBe(new URL(raw).href);
      expect(d.reason, raw).toBe('');
    }
    // 规范化确实发生了（否则上一条就等于"原样返还"，测不出东西）
    expect(JUDGE('externalUrl', 'https://example.com').abs).toBe('https://example.com/');
  });

  it('这一档**不看项目**：没有 `project` 也照样放行（它不是路径，不该被 `no-project` 卡）', () => {
    const d = decide({ kind: 'externalUrl', raw: 'https://example.com/x' });
    expect(d.ok).toBe(true);
    expect(d.action).toBe('external');
    // 反证：同一条 raw 拿**相对路径**档判会 reject ⇒ 两档确实不同源
    expect(decide({ kind: 'attachment', raw: 'https://example.com/x' }).ok).toBe(false);
  });

  it('危险 scheme **全部** reject + `code=path-url-scheme` + 非空 reason（文案单源）', () => {
    for (const raw of [
      'javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///E:/x.txt',
      'vbscript:msgbox', 'blob:https://a/b', 'aimm://demo/n1',
      'about:blank', 'chrome://settings', 'ftp://a/b'
    ]) {
      const d = JUDGE('externalUrl', raw);
      expect(d.ok, raw).toBe(false);
      expect(d.code, raw).toBe(CODE_PREFIX + 'url-scheme');
      expect(d.action, raw).toBe('reject');
      expect(d.abs, raw).toBeNull();
      expect(d.reason.length, raw).toBeGreaterThan(0);
      expect(d.reason, raw).toBe(REASONS[d.code]);      // 文案只有一处
    }
  });

  it('带凭据的网址 reject（交出去会把账号密码带进地址栏与历史）', () => {
    for (const raw of ['http://user:pass@example.com/x', 'https://user@example.com/x', 'https://a%40b@c/']) {
      const d = JUDGE('externalUrl', raw);
      expect(d.ok, raw).toBe(false);
      expect(d.code, raw).toBe(CODE_PREFIX + 'url-credentials');
      expect(d.reason.length, raw).toBeGreaterThan(0);
      expect(d.reason, raw).toBe(REASONS[d.code]);
    }
  });

  it('畸形 URL reject（`new URL()` 解不开的一律不交出去）', () => {
    for (const raw of ['http://', 'https://', 'not a url', 'http://x:99999/', 'https://a b/', 'https:///']) {
      const d = JUDGE('externalUrl', raw);
      expect(d.ok, raw).toBe(false);
      expect(d.code, raw).toBe(CODE_PREFIX + 'url-malformed');
      expect(d.reason.length, raw).toBeGreaterThan(0);
    }
  });

  it('设备路径 / UNC / 控制字符在这一档**也拒**（判据 2 先于 URL 档跑）', () => {
    expect(JUDGE('externalUrl', '\\\\?\\C:\\Windows\\win.ini').code).toBe(CODE_PREFIX + 'unc-device');
    expect(JUDGE('externalUrl', '\\\\NAS\\share\\x').code).toBe(CODE_PREFIX + 'unc-device');
    expect(JUDGE('externalUrl', 'https://e.com/a\nb').code).toBe(CODE_PREFIX + 'control-char');
    expect(JUDGE('externalUrl', 'https://e.com/a\u0000b').code).toBe(CODE_PREFIX + 'control-char');
  });

  it('`force` 传 system **压不过** reject，也改不了 `external`（不是一条更松的口子）', () => {
    expect(JUDGE('externalUrl', 'https://example.com/x', PROJECT, 'system').action).toBe('external');
    const rej = JUDGE('externalUrl', 'javascript:alert(1)', PROJECT, 'system');
    expect(rej.ok).toBe(false);
    expect(rej.action).toBe('reject');
  });

  it('协议白名单**就是那两条**，大写协议名/主机名同样放行（规范化后按小写判）', () => {
    expect(ALLOWED_URL_PROTOCOLS).toEqual(['http:', 'https:']);
    const d = JUDGE('externalUrl', 'HTTP://Example.COM/A');
    expect(d.ok).toBe(true);
    expect(d.abs).toBe('http://example.com/A');
  });

  /* 这一条是**反向证据**：本批本来打算加 `path-url-no-host`（"网址没有主机名"），
   * 取证后发现它**不可达** —— http:/https: 是 WHATWG 的 special scheme，解析器要么给出非空 host、
   * 要么直接抛 `ERR_INVALID_URL`。留一条永远打不出来的 reject = 让人以为守住了 ⇒ **不加**。
   * 这条断言把"不加"这件事钉住，免得下次有人"顺手补上"一条空转的守卫。 */
  it('`REASONS` 里**没有** `path-url-no-host`（不可达的守卫不许存在），且"不可达"有读数', () => {
    expect(Object.keys(REASONS)).not.toContain(CODE_PREFIX + 'url-no-host');
    let parsedWithEmptyHost = 0;
    let threw = 0;
    for (const raw of ['http://', 'https://', 'http://?x', 'http://#x', 'http://:80/', 'https:///',
      'http://@', 'https://a b/', 'http://user@/x']) {
      try {
        const u = new URL(raw);
        if ((u.protocol === 'http:' || u.protocol === 'https:') && !u.host) parsedWithEmptyHost++;
      } catch (e) { threw++; }
    }
    expect(threw, '这些形状应当解析失败').toBeGreaterThan(0);
    expect(parsedWithEmptyHost, '白名单内且 host 为空 ⇒ 0 条（否则 no-host 就该存在）').toBe(0);
  });
});

describe('path-chain 结构断言：只有一处实现', () => {
  const rendererFiles = readdirSync(path.join(ROOT, 'renderer')).filter((n) => /\.js$/.test(n));

  it('渲染层不再自己拼页面相对地址（`../projects/` 在 renderer/** 零命中）', () => {
    const hits = [];
    for (const f of rendererFiles) {
      const src = stripComments(readFileSync(path.join(ROOT, 'renderer', f), 'utf8'));
      if (src.indexOf("'../projects/'") >= 0 || src.indexOf('"../projects/"') >= 0) hits.push(f);
    }
    expect(hits).toEqual([]);
    // 而它**必须**在唯一实现里出现（否则这条断言会因为"谁都没拼"而假绿）
    expect(stripComments(readFileSync(path.join(ROOT, 'src/path-chain.js'), 'utf8')).indexOf("'../projects/'"))
      .toBeGreaterThan(-1);
  });

  it('渲染层与主进程外壳不再自己判"能不能开"：判据 code 只在模块里出现', () => {
    const targets = ['main.js', 'preload.js']
      .concat(rendererFiles.map((f) => path.join('renderer', f)));
    for (const rel of targets) {
      let src;
      try { src = stripComments(readFileSync(path.join(ROOT, rel), 'utf8')); } catch (e) { continue; }
      for (const code of ['escape', 'unc-device', 'no-project', 'not-relative', 'too-long']) {
        expect(src.indexOf("'" + CODE_PREFIX + code + "'"), rel + ' 不该出现判据 code ' + CODE_PREFIX + code).toBe(-1);
      }
    }
  });

  it('两个调用点都在**调**判据（不是自己判断）', () => {
    const media = stripComments(readFileSync(path.join(ROOT, 'renderer/app-media.js'), 'utf8'));
    const detail = stripComments(readFileSync(path.join(ROOT, 'renderer/app-detail-content.js'), 'utf8'));
    expect(media.indexOf('window.MMPathChain.decide')).toBeGreaterThan(-1);
    expect(media.indexOf('window.MMPathChain.rendererUrlOf')).toBeGreaterThan(-1);
    expect(detail.indexOf('window.MMPathChain.decide')).toBeGreaterThan(-1);
    expect(detail.indexOf('MM.imageLinkOf')).toBeGreaterThan(-1);
    // 旧的拼接算式在渲染层彻底消失
    expect(media.indexOf('state.project.file.replace')).toBe(-1);
    expect(detail.indexOf('state.project.file.replace')).toBe(-1);
  });
});

describe('path-chain 结构断言：外部链接也是**同一条出口**（不新开 IPC、不并列一份白名单）', () => {
  it('全仓只有**一条** `ipcMain.handle(\'app:open-file\')`，且没有第二个"打开"IPC 名字', () => {
    const main = stripComments(readFileSync(path.join(ROOT, 'main.js'), 'utf8'));
    const handles = [...main.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(handles.filter((n) => n === 'app:open-file').length,
      'app:open-file 的 handler 必须恰好一处（出口唯一）').toBe(1);
    expect(handles.filter((n) => /open[-_]?(url|external)|external|openExternal/i.test(n)),
      '不许为"开外部东西"另立 IPC 名字').toEqual([]);
  });

  it('`shell.openExternal` 在 main.js 里**只出现一处**，且在 `app:open-file` 的 handler 之内', () => {
    const main = stripComments(readFileSync(path.join(ROOT, 'main.js'), 'utf8'));
    const hits = [...main.matchAll(/shell\.openExternal\(/g)].length;
    expect(hits, 'main.js 里 shell.openExternal 只许有一处（多一处=多一条出口）').toBe(1);
    const handlerAt = main.indexOf("ipcMain.handle('app:open-file'");
    const callAt = main.indexOf('shell.openExternal(');
    expect(handlerAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(handlerAt);
    // 调用点之后、下一个 ipcMain.handle 之前不许再有别的 handler 开头把它"隔"到另一个 handler 里
    const nextHandler = main.indexOf('ipcMain.handle(', callAt);
    expect(nextHandler === -1 || nextHandler > callAt).toBe(true);
  });

  it('协议白名单**只有一处**（`ALLOWED_URL_PROTOCOLS` 只在 src/path-chain.js）；外壳与渲染层都不自己列', () => {
    for (const rel of ['main.js', 'preload.js', 'renderer/app-media.js', 'renderer/app-md.js']) {
      const src = stripComments(readFileSync(path.join(ROOT, rel), 'utf8'));
      expect(src.indexOf('ALLOWED_URL_PROTOCOLS'), rel + ' 不该自己列协议白名单').toBe(-1);
      expect(src.indexOf("'http:'"), rel + ' 不该自己列协议白名单（字面量）').toBe(-1);
      expect(src.indexOf('"http:"'), rel + ' 不该自己列协议白名单（字面量）').toBe(-1);
    }
    const chainSrc = stripComments(readFileSync(path.join(ROOT, 'src/path-chain.js'), 'utf8'));
    expect(chainSrc.indexOf('ALLOWED_URL_PROTOCOLS'), '否则上一条会因为"谁都没列"而假绿').toBeGreaterThan(-1);
    expect(chainSrc.indexOf("'http:'")).toBeGreaterThan(-1);
  });

  it('渲染层的 `http(s)` 链接走**判据 + 既有出口**：不直接碰 IPC、不自己判 scheme', () => {
    const md = stripComments(readFileSync(path.join(ROOT, 'renderer/app-md.js'), 'utf8'));
    expect(md.indexOf("kind: 'externalUrl'"), '正文链接必须落到 externalUrl 这一档').toBeGreaterThan(-1);
    expect(md.indexOf('MM.openByChain'), '出口必须复用 openByChain（→ requestOpen → app:open-file）').toBeGreaterThan(-1);
    expect(md.indexOf('desktop.app.openFile'), '渲染层不许自己直连 IPC').toBe(-1);
    expect(md.indexOf('openExternal'), '渲染层不许自己提 shell.openExternal').toBe(-1);
    // 而 `kind:'externalUrl'` **必须**在出口调用点（app-media.js）被原样递给主进程
    const media = stripComments(readFileSync(path.join(ROOT, 'renderer/app-media.js'), 'utf8'));
    expect(media.indexOf('kind: d.kind'), '出口调用点要把判据判出的档位递给主进程').toBeGreaterThan(-1);
  });
});

describe('path-chain 与改动前实现的等价性（合成样本，数据无关、可重复）', () => {
  it('合成边界样本全部符合期望（其中一部分是**有意的更严**）', () => {
    const r = conformance.runSynthetic();
    expect(r.total).toBe(conformance.SYNTHETIC.length);
    expect(r.failed).toBe(0);
    expect(r.expectedTighter).toBeGreaterThan(0);
    expect(r.expectedSame).toBeGreaterThan(0);
    const notPass = r.rows.filter((x) => !x.pass).map((x) => x.kind + ' ' + x.raw);
    expect(notPass).toEqual([]);
  });

  it('路径类字段的点名清单里有"在链上"的三类（对拍脚本与实现同一份清单）', () => {
    const onChain = conformance.FIELD_CLASSES.filter((f) => f.consumed).map((f) => f.id);
    expect(onChain).toEqual(['files[].file', 'images[].file', 'localPath']);
  });
});
