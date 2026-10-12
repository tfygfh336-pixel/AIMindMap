/* ============================================================
 * tests/import-dir-refs.test.js — 【批6】整库导入（`import-dir`）时图片/附件引用的落地
 * 运行：npx vitest run tests/import-dir-refs.test.js
 * ------------------------------------------------------------
 * ## 守什么（每条都对着一个**能红**的判据）
 * W19 给 `import-md` / `import-project` 修好了"md 里的图片/附件引用"，但整库导入**仍是老口径**：
 * `buildDirImportTree` 把 md 里那行原样写进 `images/files` ⇒ 静默留**悬空引用**（而 exit 0、
 * 回显里一个字都没说、`validate` 照样通过 —— 实测取证见 `tests/import-refs.test.js` 的文件头）。
 * 本件把整库那条接到**同一处实现**（`src/markdown.js` 的 `resolveImportRefs`），口径选
 * `onMissing:'detail'`（**整库不该为一条坏引用全灭**；为什么与单文件命令不同：见
 * `src/doc-import.js` 的 ⓪⁗ 契约段）。四组断言：
 *   A. 一个目录里同时有【能解析的引用 + 解析不到的坏引用 + 远程引用】⇒
 *      · 能解析的**真被复制进项目**（`assets/`/`attachments/` 里文件在、字节与源相同）、引用写成项目内相对路径；
 *      · 坏引用**逐条点名**（哪个文件 / 原样路径 / 为什么 / 按序试过哪些路径）、**不写悬空引用**、
 *        那一行**按正文**留在节点详情里（内容不丢）；
 *      · 远程引用**不挂进 images/files**、同样按正文保留；整库导入**不因坏引用被拒**（exit 0）+ `validate` 0。
 *   B. `--dry-run`：**不复制、不建项目目录**，但报告要照样说得清（哪条会落、哪条落不了）。
 *   C. **注入证明（判别力）**：把整库那条打桩回**老口径**（不调 `resolveImportRefs`）⇒ A 的**同一批断言必红**
 *      （资产没被复制、悬空引用落了盘）⇒ 还原 ⇒ 复绿。这份"必红"才是 A 不是"看起来测了"的证据。
 *   D. **一处实现**：解析/复制/改名/降级成正文只有 `markdown.resolveImportRefs` 一处；
 *      `src/doc-import.js` 只交"落点"（`refTargets`），**不许出现复制调用或第二份命名表达式** ✗；
 *      `import-dir` 那条调用点在唯一的 `resolveDirImportRefs` 里，且口径只有一个字面量。
 * ## 环境要点
 *   · 端到端一律走**进程内** `invokeSync`（同 tests/import-refs.test.js），不起子进程；
 *   · `AI_MINDMAP_PROJECTS_DIR` 必须在 require CLI **之前**生效，不生效就**当场红**
 *     （夹具写进真实 `projects/` 是本文件可能犯的最坏的错）；
 *   · 沙箱与夹具都在 `os.tmpdir()` 下，`afterAll` 全清 —— 仓库根与真实 `projects/` 全程零接触。
 * ============================================================ */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/* ---- ① 重定向必须先于 require cli/main.js（cli/core.js 的 PROJECTS_DIR 是模块加载时定型的） ---- */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-b6-sbx-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-b6-work-'));
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const markdown = require('../src/markdown.js');
const docImport = require('../src/doc-import.js');

if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效（cli/core.js 已被更早加载）：PROJECTS_DIR='
    + core.PROJECTS_DIR + ' 期望=' + SANDBOX + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (argv) => invokeSync(argv);

/* ---- ② 夹具：一个"什么引用都有"的目录 ---- */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngBytes(tag) { return Buffer.concat([PNG_MAGIC, Buffer.from('#' + tag, 'utf8')]); }
function attachmentBytes(tag) { return Buffer.from('# 附件 ' + tag + '\n正文\n', 'utf8'); }

/** 整库导入的源目录（**只读夹具**：导入过程不许改它一个字节 —— B 组会验） */
function mkLib(label) {
  const dir = path.join(WORK, label);
  fs.mkdirSync(path.join(dir, '笔记', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(dir, '笔记', 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(dir, '笔记', 'assets', 'good.png'), pngBytes('good'));
  fs.writeFileSync(path.join(dir, '笔记', 'attachments', 'doc.md'), attachmentBytes('doc'));
  fs.writeFileSync(path.join(dir, '笔记', '第一章.md'), [
    '# 第一章', '',
    '![图：能解析的](assets/good.png)', '',
    '![图：坏了的](assets/gone.png)', '',
    '![图：外链](https://example.com/a.png)', '',
    '[📎 附件：能解析的 — attachments/doc.md](attachments/doc.md)', '',
    '正文一', ''
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(dir, '笔记', '第二章.md'), ['# 第二章', '', '正文二', ''].join('\n'), 'utf8');
  return dir;
}

const projDir = (name) => path.join(SANDBOX, name);
const projFile = (name) => path.join(projDir(name), name + '.json');
function listDir(d) { try { return fs.readdirSync(d).sort(); } catch (e) { return null; } }
function readProj(name) { return JSON.parse(fs.readFileSync(projFile(name), 'utf8')); }
function refsOf(name) {
  const out = [];
  (function w(n) {
    if (!n) return;
    (n.images || []).forEach((i) => out.push({ node: n.topic, kind: 'image', file: i.file, caption: i.caption }));
    (n.files || []).forEach((f) => out.push({ node: n.topic, kind: 'file', file: f.file, caption: f.caption }));
    (n.children || []).forEach(w);
  })(readProj(name).data);
  return out;
}
/** 悬空引用 = `file` 不是项目内路径，或那个文件在盘上不存在（老口径下必然非空） */
function danglingOf(name) {
  return refsOf(name).filter((r) => !fs.existsSync(path.join(projDir(name), r.file)));
}
function detailsOf(name) {
  const out = [];
  (function w(n) { if (!n) return; if (n.detail) out.push(n.detail); (n.children || []).forEach(w); })(readProj(name).data);
  return out.join('\n');
}
/** 某个文件节点（按 origin.src 认）——用来把"这段详情属于哪个文件"钉住 */
function nodeBySrc(name, re) {
  let hit = null;
  (function w(n) {
    if (!n || hit) return;
    if (n.origin && re.test(String(n.origin.src))) { hit = n; return; }
    (n.children || []).forEach(w);
  })(readProj(name).data);
  return hit;
}

/**
 * **A 组的判据本身**（正向断言与注入证明共用同一个函数 —— 打桩回老口径时它必须红）。
 * @param {string} name 项目名
 * @param {{assets:number, attachments:number}} want 期望的项目内文件数
 */
function assertDirRefsLanded(name, want) {
  const v = run(['validate', name]);
  expect(v.code, 'validate 必须通过：' + v.stdout).toBe(0);
  expect(listDir(path.join(projDir(name), 'assets')) || [], 'assets/ 里的文件').toHaveLength(want.assets);
  expect(listDir(path.join(projDir(name), 'attachments')) || [], 'attachments/ 里的文件').toHaveLength(want.attachments);
  const refs = refsOf(name);
  expect(refs.length).toBeGreaterThan(0);
  refs.forEach((r) => {
    expect(/^(assets|attachments)\//.test(r.file), '引用必须是项目内相对路径: ' + r.file).toBe(true);
    expect(fs.existsSync(path.join(projDir(name), r.file)), '引用指向的文件必须真的在: ' + r.file).toBe(true);
  });
  expect(danglingOf(name), '不许有悬空引用').toEqual([]);
  // 远程引用与坏引用都**不许挂进 images/files**（`file` 的规范是项目内相对路径）
  refs.forEach((r) => {
    expect(/^https?:|^data:/.test(r.file), '远程引用不许当成项目内路径落盘: ' + r.file).toBe(false);
    expect(/gone\.png$/.test(r.file), '坏引用不许落盘: ' + r.file).toBe(false);
  });
}

afterAll(() => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* 清不掉不影响结论 */ }
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* 同上 */ }
});

/* ============================================================================
 * A. 一个目录里三种引用都有 ⇒ 该落的落、该说的说、不阻断
 * ========================================================================== */
describe('【批6】A. 整库导入：能解析的真复制、坏引用逐条点名但不阻断、远程按正文保留', () => {
  let lib;
  let r;
  beforeAll(() => {
    lib = mkLib('a');
    r = run(['import-dir', 'b6-a', lib, '--title', '书库']);
  });

  it('① 导入成功（exit 0）+ 导入后 `validate` exit 0：坏引用**不阻断整库**（这正是选 detail 的理由）', () => {
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain('已整库导入');
    expect(r.stdout).not.toContain('error:');
  });

  it('② 能解析的引用**真被复制进项目**：assets/ 1 个、attachments/ 1 个，内容与源逐字节相同', () => {
    assertDirRefsLanded('b6-a', { assets: 1, attachments: 1 });
    const refs = refsOf('b6-a');
    const imgRef = refs.filter((x) => x.kind === 'image')[0].file;
    const attRef = refs.filter((x) => x.kind === 'file')[0].file;
    expect(imgRef).toMatch(/^assets\//);
    expect(attRef).toMatch(/^attachments\//);
    expect(fs.readFileSync(path.join(projDir('b6-a'), imgRef))).toEqual(pngBytes('good'));
    expect(fs.readFileSync(path.join(projDir('b6-a'), attRef))).toEqual(attachmentBytes('doc'));
  });

  it('③ 引用写的是**项目内相对路径**（不是源目录里的写法）—— 复制落地后 `images/files` 里没有源路径', () => {
    // `assets/good.png` 是源目录里的写法；落地后必须换成 `assets/<新名>`（名字带上时间36进制 + 4 位随机）
    refsOf('b6-a').forEach((x) => {
      expect(x.file).not.toBe('assets/good.png');
      expect(x.file).not.toBe('attachments/doc.md');
      expect(x.file, '复制来的新名字：时间36进制 + 4 位随机 + 扩展名（与 add-image 同一条）')
        .toMatch(/^(assets\/[0-9a-z]{4,}\.png|attachments\/[0-9a-z]{4,}\.md)$/);
    });
  });

  it('④ 坏引用**逐条点名**（哪个文件 / 原样路径 / 为什么 / 按序试过哪些路径），且说清"不阻断、按正文保留"', () => {
    expect(r.stdout).toContain('笔记/第一章.md');            // 哪个文件（相对源目录的路径）
    expect(r.stdout).toContain('assets/gone.png');           // 原样路径
    expect(r.stdout).toContain('源文件不存在');               // 为什么
    expect(r.stdout).toContain('按序试过');                   // 试过哪些候选路径
    expect(r.stdout).toContain('按正文');
    expect(r.stdout).toContain('不阻断');
    expect(r.stdout, '不许说成"拒绝整份导入"（那是单文件命令的口径）').not.toContain('拒绝整份导入');
  });

  it('⑤ 坏引用**不写悬空引用**、那一行**按正文**留在它所属节点（内容不丢）', () => {
    assertDirRefsLanded('b6-a', { assets: 1, attachments: 1 });
    const det = detailsOf('b6-a');
    expect(det, '坏引用的那一行要按正文保留').toContain('assets/gone.png');
    expect(det).toContain('坏了的');                          // caption 也在
  });

  it('⑥ 远程引用（https:）同样**不挂进 images/files**、按正文保留，并在报告里被点名', () => {
    expect(refsOf('b6-a').some((x) => /^https?:/.test(x.file))).toBe(false);
    expect(detailsOf('b6-a')).toContain('https://example.com/a.png');
    expect(r.stdout).toContain('https://example.com/a.png');
    expect(r.stdout).toContain('非本地引用');
  });

  it('⑦ `--json` 的报告也逐条可判（按文件分组：坏引用带 tried、口径字段是 detail）', () => {
    const lib2 = mkLib('a-json');
    const rj = run(['import-dir', 'b6-a-json', lib2, '--json']);
    expect(rj.code, rj.stdout).toBe(0);
    const rep = JSON.parse(rj.stdout);
    expect(rep.resourceRefs.onMissing).toBe('detail');
    expect(rep.resourceRefs.copy).toBe(2);                    // 图片 + 附件
    expect(rep.resourceRefs.remote).toBe(1);
    expect(rep.resourceRefs.missing).toBe(1);
    expect(rep.resourceRefs.files).toBe(1);                   // 只有 第一章.md 里有引用
    // 清单有上限 ⇒ 总数必须一并给出（截断要看得见；这里 4 条未截断，所以两者相等）
    expect(rep.resourceRefs.itemsTotal).toBe(4);
    expect(rep.resourceRefs.items.length).toBe(4);
    expect(rep.resourceRefs.badTotal).toBe(1);
    const bad = rep.resourceRefs.bad.filter((b) => b.status === 'missing')[0];
    expect(bad.file).toBe('笔记/第一章.md');
    expect(bad.ref).toBe('assets/gone.png');
    expect(bad.tried.length).toBeGreaterThan(0);              // 按序试过的路径
    expect(bad.tried.some((p) => /assets[\\/]gone\.png$/.test(p))).toBe(true);
  });

  it('⑧ 图片格式不受支持（`.tiff`，与 `add-image` 同一条白名单）也算"坏引用"：不复制、按正文保留、逐条点名', () => {
    const lib = mkLib('a-ext');
    fs.writeFileSync(path.join(lib, '笔记', 'assets', 'pic.tiff'), pngBytes('tiff'));
    fs.writeFileSync(path.join(lib, '笔记', '第三章.md'),
      ['# 第三章', '', '![图：扫描稿](assets/pic.tiff)', ''].join('\n'), 'utf8');
    const r3 = run(['import-dir', 'b6-a-ext', lib, '--json']);
    expect(r3.code, r3.stdout).toBe(0);                       // 单文件命令这条会**拒绝整份导入**，整库不
    const rep = JSON.parse(r3.stdout);
    expect(rep.resourceRefs.badExt).toBe(1);
    const bad = rep.resourceRefs.bad.filter((b) => b.status === 'bad-ext')[0];
    expect(bad.file).toBe('笔记/第三章.md');
    expect(bad.ref).toBe('assets/pic.tiff');
    expect(bad.reason).toContain('不是受支持的图片格式');
    // 那条引用没落进 images，也没留在 images 里当悬空引用；内容进了 detail
    expect(refsOf('b6-a-ext').some((x) => /pic\.tiff$/.test(x.file))).toBe(false);
    expect(danglingOf('b6-a-ext')).toEqual([]);
    expect(detailsOf('b6-a-ext')).toContain('assets/pic.tiff');
  });
});

/* ============================================================================
 * B. --dry-run：只预览（不复制、不建项目），但报告照样说得清
 * ========================================================================== */
describe('【批6】B. 整库导入 --dry-run：预览引用落地情况，**零副作用**', () => {
  it('预览报"将复制 2 个文件"、坏引用点名，而**项目目录没被建、源目录一个字节没变**', () => {
    const lib = mkLib('b');
    const snap = (dir) => {
      const out = [];
      (function w(d) {
        fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
          const p = path.join(d, e.name);
          out.push(p + '|' + (e.isDirectory() ? 'd' : fs.readFileSync(p).length + ':' + fs.statSync(p).mtimeMs));
          if (e.isDirectory()) w(p);
        });
      })(dir);
      return out;
    };
    const before = snap(lib);
    const r = run(['import-dir', 'b6-b', lib, '--dry-run']);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain('将复制 2 个文件进项目');
    expect(r.stdout).toContain('assets/gone.png');            // 坏引用照样点名
    expect(r.stdout).toContain('按正文');
    expect(r.stdout).toContain('--dry-run 不复制文件、不建目录、不改任何数据');
    expect(fs.existsSync(projDir('b6-b')), '--dry-run 不许建项目目录').toBe(false);
    expect(snap(lib), '源目录逐字节/逐 mtime 未变').toEqual(before);
    // JSON 预览与真导**同一份判据**（同一批状态，不是"预览说会落、真导没落"）
    const rj = run(['import-dir', 'b6-b-json', lib, '--dry-run', '--json']);
    const rep = JSON.parse(rj.stdout);
    expect(rep.resourceRefs.copy).toBe(2);
    expect(rep.resourceRefs.missing).toBe(1);
    expect(rep.wouldRefuse).toBe(false);                      // 坏引用**不构成拒绝理由**（detail 口径）
    expect(fs.existsSync(projDir('b6-b-json'))).toBe(false);
  });
});

/* ============================================================================
 * C. 注入证明：打桩回老口径（不调 resolveImportRefs）⇒ A 的同一批断言必红
 * ========================================================================== */
describe('【批6】C. 注入证明（判别力）：接回老口径 ⇒ A 的断言必红，还原 ⇒ 复绿', () => {
  /** 老口径替身：整库导入**不解析引用**（= 改动前 `buildDirImportTree` 把原样字符串写进 images/files） */
  const OLD_BEHAVIOR = () => ({
    ok: true, applied: false, dryRun: false, onMissing: 'refuse',
    refs: [], blocked: [], copied: [], inProject: [], remote: [], dropped: []
  });

  it('打桩 ⇒ exit 0 却留下悬空引用、资源没被复制、坏引用一个字都不提（`assertDirRefsLanded` 必红）', () => {
    const lib = mkLib('c');
    const real = markdown.resolveImportRefs;
    markdown.resolveImportRefs = OLD_BEHAVIOR;
    let msg = '';
    try {
      const r = run(['import-dir', 'b6-c-old', lib]);
      expect(r.code, '老口径：照样"成功"（这正是缺陷的样子）').toBe(0);
      expect(run(['validate', 'b6-c-old']).code, '老口径：validate 照样通过 ⇒ "绿"证明不了不留坏引用').toBe(0);
      expect(listDir(path.join(projDir('b6-c-old'), 'assets')), '老口径：资源从来没被复制').toBe(null);
      expect(danglingOf('b6-c-old'), '老口径：悬空引用落了盘').not.toEqual([]);
      expect(r.stdout, '老口径：坏引用**一个字都没说**（静默写脏）').not.toContain('gone.png');
      try {
        assertDirRefsLanded('b6-c-old', { assets: 1, attachments: 1 });   // ← 必红
      } catch (e) {
        msg = String((e && e.message) || e);
      }
      expect(msg, '注入后同一批断言必须红').not.toBe('');
      console.log('[注入读数·老口径] exit=' + r.code
        + ' ｜ validate=' + run(['validate', 'b6-c-old']).code
        + ' ｜ assets/ 目录=' + JSON.stringify(listDir(path.join(projDir('b6-c-old'), 'assets')))
        + ' ｜ images/files 里的原样引用=' + JSON.stringify(refsOf('b6-c-old').map((x) => x.file))
        + ' ｜ 悬空引用数=' + danglingOf('b6-c-old').length
        + ' ｜ 报告里有没有点名坏引用=' + (r.stdout.indexOf('gone.png') >= 0)
        + ' ｜ 断言红于=' + msg.split('\n').map((s) => s.trim()).filter(Boolean)[0]);
    } finally {
      markdown.resolveImportRefs = real;
    }
  });

  it('还原 ⇒ 同一份夹具恢复"落地 + 点名"两条行为（证明上一条红的是断言、不是环境）', () => {
    expect(markdown.resolveImportRefs).not.toBe(OLD_BEHAVIOR);
    const lib = mkLib('c-restore');
    const r = run(['import-dir', 'b6-c-new', lib]);
    expect(r.code, r.stdout).toBe(0);
    assertDirRefsLanded('b6-c-new', { assets: 1, attachments: 1 });
    expect(r.stdout).toContain('assets/gone.png');
    expect(r.stdout).toContain('源文件不存在');
  });

  it('把口径换成单文件的 `refuse` ⇒ **响亮拒绝 + 项目没被建**（不许"报告说已按正文保留、盘上却是悬空引用"）', () => {
    const lib = mkLib('c-refuse');
    const real = markdown.resolveImportRefs;
    // 只强改口径（其余照旧）：模拟"有人把整库那条接到了单文件命令的拒绝口径上"
    markdown.resolveImportRefs = (roots, opts) => real(roots, Object.assign({}, opts, { onMissing: 'refuse' }));
    try {
      const r = run(['import-dir', 'b6-c-refuse', lib]);
      expect(r.code, '口径不对 ⇒ 必须非 0（不能静默按"已落地"往下走）').toBe(1);
      expect(r.stdout).toContain('error:');
      expect(r.stdout).toContain('口径必须是 detail');
      expect(r.stdout).toContain('拒绝写盘');
      expect(fs.existsSync(projFile('b6-c-refuse')), '项目文件一个字都不许写').toBe(false);
      expect(listDir(path.join(projDir('b6-c-refuse'), 'assets')), '拒绝时不许复制任何资源').toBe(null);
      console.log('[注入读数·口径被改成 refuse] exit=' + r.code + ' ｜ 项目文件存在='
        + fs.existsSync(projFile('b6-c-refuse')) + ' ｜ 报文=' + r.stdout.split('\n')[0].slice(0, 120));
    } finally {
      markdown.resolveImportRefs = real;
    }
  });
});

/* ============================================================================
 * D. 一处实现 / 单源口径（源码级把守 + `refTargets` 的单元级契约）
 * ========================================================================== */
describe('【批6】D. 解析与复制只有一处实现；doc-import.js 只交"落点"', () => {
  const cmdSrc = fs.readFileSync(path.join(REPO, 'cli', 'commands', 'project.js'), 'utf8');
  const diSrc = fs.readFileSync(path.join(REPO, 'src', 'doc-import.js'), 'utf8');
  const mdSrc = fs.readFileSync(path.join(REPO, 'src', 'markdown.js'), 'utf8');

  it('三条导入命令调的是同一个函数（4 处调用 / 1 处定义），整库那条在唯一的 `resolveDirImportRefs` 里', () => {
    expect((cmdSrc.match(/markdown\.resolveImportRefs\(/g) || [])).toHaveLength(4);
    expect((mdSrc.match(/function resolveImportRefs\(/g) || [])).toHaveLength(1);
    expect((cmdSrc.match(/function resolveDirImportRefs\(/g) || [])).toHaveLength(1);
    // 整库那条的基准目录**逐文件**取自 doc-import.js 交出来的落点（不是全库共用一个）
    expect(cmdSrc).toContain('refResolveOptsAt(ctx, name, t.baseDir)');
  });

  it('整库的 `onMissing` 口径只有**一个**字面量（报告字段与实参共用它，不会两头各说一套）', () => {
    expect(cmdSrc).toContain("const DIR_REF_ON_MISSING = 'detail';");
    expect(cmdSrc).toContain('{ onMissing: DIR_REF_ON_MISSING, dryRun: !!dryRun }');
    expect(cmdSrc).toContain('onMissing: DIR_REF_ON_MISSING,             // 口径本身也要看得见');
  });

  it('`src/doc-import.js` **不另起一套**：没有复制调用、没有第二份命名表达式，只交出 `refTargets`', () => {
    expect(diSrc).not.toContain('copyFileSync');
    expect(diSrc).not.toContain('Date.now().toString(36)');    // 命名表达式仍只属于 assets.js / markdown.js
    expect(diSrc).not.toContain('IMAGE_EXT_RE');               // 图片白名单也不在这里再写一份
    expect(diSrc).toContain('built.refTargets.push');
    expect(diSrc, '契约句要指向唯一实现').toContain('resolveImportRefs');
  });

  it('`scanImportDir` + `buildDirImportTree` 的 `refTargets`：每个导入成功的文件各一条，baseDir = 该文件所在目录', () => {
    const lib = mkLib('d-unit');
    const built = docImport.buildDirImportTree(docImport.scanImportDir(lib, {}), { at: 'T' });
    // ⚠️ 夹具里的 `笔记/attachments/doc.md` 也是 .md ⇒ 它**本身就是一份可导入的文件**（整库导入
    //    "镜像文件夹"的既有语义：先按扩展名收，不按"像不像附件"猜）—— 于是这里共 3 个文件节点。
    expect(built.files).toBe(3);
    expect(built.refTargets.map((t) => t.rel).sort())
      .toEqual(['笔记/attachments/doc.md', '笔记/第一章.md', '笔记/第二章.md']);
    built.refTargets.forEach((t) => {
      expect(t.baseDir).toBe(path.dirname(path.join(lib, t.rel)));
      expect(t.node && t.node.id, 'node 是那个文件节点本身').toBeTruthy();
      expect(t.node.origin.src.endsWith('/' + t.rel)).toBe(true);
    });
    // 建树**不碰盘**：这个函数不许自己复制资源（老口径的缺陷就是"没人复制、却照样落盘引用"）
    expect(listDir(path.join(projDir('b6-d-unused'), 'assets'))).toBe(null);
  });

  it('沙箱自证：项目根在临时目录里，真实 `projects/` 全程零接触', () => {
    expect(path.resolve(core.PROJECTS_DIR)).toBe(path.resolve(SANDBOX));
    expect(path.resolve(SANDBOX).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    listDir(SANDBOX).forEach((n) => expect(path.resolve(projDir(n)).startsWith(path.resolve(SANDBOX))).toBe(true));
  });
});
