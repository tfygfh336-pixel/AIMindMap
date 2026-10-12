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
 *   E. 【批7】**两条边界补成机械断言**（批6 只在交付说明里登记过，没有任何断言）：
 *      ① **一条引用一份副本、不做内容去重**：同一张图被两处引用（同一文件两处 / 两个文件各一处）
 *         ⇒ `assets/` 里**两个文件**、`images[].file` 两条**指向不同路径**、两个文件**字节都等于源**；
 *      ② "同一来源连导两次（第二次 `--force`）⇒ 资源多一份"**以实测为准分三档**：
 *         `import-dir` **同一项目名**再导 ⇒ 被"项目已存在"闸拦下（`assets/` 计数降 N → N，一个字节不多复制）；
 *         `import-dir` 同一来源换**新项目**（`--force` 才过重复目录闸）⇒ 新项目里**又各复制一份**（全库 N → 2N）；
 *         `N → N+1`（批6 登记的字面读数）**只在 `import-md --force`** 这条"往已有项目再导一次"的路径上成立。
 *         ⚠️ 登记值"`--force` 重导会再复制一份（N+1）"在 `import-dir` 这条路上**不成立** —— 以实测为准，
 *         详见 E-② 的用例注释与批7 交付说明。
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
const assetsOf = (name) => listDir(path.join(projDir(name), 'assets'));

/** 【批7】夹具的一种：`files` 决定目录里有哪些 md（`笔记/assets/good.png` 恒在，供引用解析） */
function mkLibWith(label, files) {
  const dir = path.join(WORK, label);
  fs.mkdirSync(path.join(dir, '笔记', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, '笔记', 'assets', 'good.png'), pngBytes('good'));
  Object.keys(files).forEach((rel) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, files[rel].join('\n'), 'utf8');
  });
  return dir;
}
/** 【批7】单文件夹具（`import-md` 那条用：它是"往**已有项目**里再导一次"唯一可达的路） */
function mkOneFile(label) {
  const dir = path.join(WORK, label);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'good.png'), pngBytes('good'));
  const f = path.join(dir, 'doc.md');
  fs.writeFileSync(f, ['# 文档', '', '![图](assets/good.png)', '', '正文', ''].join('\n'), 'utf8');
  return f;
}
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

/* ============================================================================
 * E. 【批7】两条边界：把"交付说明里的登记值"补成**机械断言**
 * ==========================================================================
 * 批6 的交付说明（提交信息 ⑦）如实登记了两条边界副作用，但**一条机械断言都没有**：
 *   · 边界①：一条引用一份副本、**不做内容去重**；
 *   · 边界②：`--force` 重导**会再复制一份**资源。
 * 本组把两条钉成端到端断言（进程内 `invokeSync`、沙箱 root、`AI_MINDMAP_PROJECTS_DIR` 已重定向）。
 * ⚠️ **以实测为准**：边界② 的字面读数（`assets/` N → N+1）在 `import-dir` 上**不成立**，
 * 详见 E-② 的用例注释（那里逐档给出实读），交付说明里也如实记了"登记值错了、真实行为是什么"。
 * ========================================================================== */
/* ============================================================================
 * 【批8】E-① 的"撞名"那一档：概率型假红的识别与规避（判据**不放宽**）
 * ==========================================================================
 * 现象：资源新名 = `Date.now().toString(36) + Math.random().toString(36).slice(2, 6)`
 *   （`src/markdown.js:139-141`，与 `cli/commands/assets.js` 的 copyAsset **逐字同一条**，
 *   两处被防漂移断言钉在一起）。同一份 md 里两条引用**必然在同一毫秒**被复制（相邻两次
 *   `copyFileSync`）⇒ 名字里的时间部分是同一个值，只剩 4 位随机后缀在区分
 *   ⇒ **撞名概率 = 1/36⁴ = 1/1,679,616**。撞上时第二次复制会**覆盖**第一次
 *   （`fs.copyFileSync` 到同一个路径，源码里没有目标存在性检查）⇒ 盘上只剩 1 个文件、
 *   两条 `images[].file` 指向同一个名字 ⇒ E-① 的"两条不同路径"**偶发变红**。
 * 为什么它对本组夹具只是一条**假红**：两条引用指向的是同一张图 ⇒ 覆盖前后内容相同、
 *   没有数据损失，产品的"不去重"语义也没变（只是名字偶然相同）。
 * 为什么**不能**直接放宽判据（用户明确否掉的那条 ✗）：把"两条路径不同"改成"路径集合势 ≥1"，
 *   正好放过本组要抓的**去重回归**（注入"按源路径去重"时磁盘态就是"1 个文件 + 两条同名"）
 *   ⇒ 判据被削弱成恒真、判别力归零。
 * 本批处置（**测试侧**，判据不放宽）：命中"撞名签名" ⇒ 换一个**全新项目**重跑一次再判；
 *   第二遍仍命中 ⇒ **判红**（结论：那不是随机撞名，而是**系统性**的去重/命名缺陷 —— 它每次都会中）。
 *   签名 = 报告 `copy=2` **且** 盘上 1 个文件 **且** 两条引用同名 **且** 那个文件逐字节等于源。
 *   为什么 `copy=2` 这一项很重要：去重实现若在 push 之前 return，报告就是 `copy=1` ⇒ **不进重试**、
 *   当场判红 ⇒ 重试只赦免"随机"这一半，不赦免任何确定性行为（改前钉的是什么、改后为什么仍有
 *   判别力，逐档写在下面的 `twoRefCaseWithRetry` / `isNameCollision` 上）。
 * 产品侧根因（【批8】登记；**【批9】已在产品侧修掉**）：`src/markdown.js` 的复制那一跳原来是
 *     const dest = path.join(dirFn(), newResourceName(ext));
 *     fs.mkdirSync(path.dirname(dest), { recursive: true });
 *     fs.copyFileSync(r.srcPath, dest);
 *   目标名不做**唯一性检查** ⇒ 同毫秒 + 同 4 位随机时，两个**不同**源文件会静默覆盖掉一个
 *   （真·数据丢失，概率同上；【批9】的独立探针实测：盘上只剩 1 个文件、两条引用**同名**、
 *   先复制的那份内容消失，而回显里还写着"已复制 2 个文件进项目"）。
 * 【批9】的修法（照本工程既有先例 `src/doc-import.js` 的 `uniqueIdGen()`："见过就再摇一次"）：
 *   copy 分支改调 `uniqueResourcePath(dirFn(), ext)` —— 撞名就**只换名字**（内容仍是那份源文件）、
 *   **绝不覆盖**已存在的文件，并带**重摇上界**（连撞 8 次 ⇒ 响亮报错，不是死循环）；
 *   不撞名时返回的就是原来那一个值 ⇒ **正常路径逐字节不变**，命名表达式一字未动。
 * 为什么这次**不必**动 `cli/commands/assets.js`：两处防漂移断言钉的是**命名表达式**
 *   （`Date.now().toString(36) + Math.random().toString(36).slice(2, 6)`，与 `IMAGE_EXT_RE`），
 *   本修法是在那个表达式**外面**加一道"目标名是否已存在"的闸 ⇒ 断言照旧成立（【批9】已核对，见交付说明④）。
 *   ⚠️ 边界（如实登记，未做）：`assets.js` 的 copyAsset / copyAttachment **仍没有这道闸** ——
 *   它们每次调用只复制一个文件，同毫秒撞名要"两个进程恰好同毫秒写同一个项目"，风险形状不同；
 *   要不要照同一条规则补上，属跨文件的产品决定。【批9】的判据在
 *   `tests/import-refs.test.js` 的【批9】组（T1 撞名时两份都在 / T2 不撞名逐字节同形 /
 *   T3 绝不覆盖 + 响亮报错 / T4 端到端接线）。
 * 本组 E-① 的**概率型规避**（`twoRefCaseWithRetry`）因此变成**不会再触发**的兜底：保留它 ——
 *   万一日后有人把产品侧那道闸去掉，它仍是唯一的"随机撞名 vs 系统性缺陷"分辨器（第二遍仍中 ⇒ 判红）。
 * ========================================================================== */

/** 跑一次"两条引用同一张图"的导入，把判定要点收成一个读数对象 */
function readTwoRefCase(lib, name) {
  const r = run(['import-dir', name, lib, '--json']);
  if (r.code !== 0) {
    return { name: name, code: r.code, stdout: r.stdout, planCopy: null, files: [], refs: [], bytesOk: false };
  }
  const files = assetsOf(name) || [];
  const refs = refsOf(name).map((x) => x.file);
  const bytesOk = files.length === 1
    && fs.readFileSync(path.join(projDir(name), 'assets', files[0])).equals(pngBytes('good'));
  return { name: name, code: r.code, stdout: r.stdout, planCopy: JSON.parse(r.stdout).resourceRefs.copy, files: files, refs: refs, bytesOk: bytesOk };
}

/** 撞名签名（**只有**这一种形态允许重试一次；其余任何形态都直接判红） */
function isNameCollision(x) {
  return x.code === 0 && x.planCopy === 2 && x.files.length === 1
    && x.refs.length === 2 && x.refs[0] === x.refs[1] && x.bytesOk;
}

/** E-① 的判据本体（两条用例共用；与批7 的断言逐条相同，只是读数先组装过一次） */
function judgeTwoRefCase(x, label) {
  expect(x.code, x.stdout).toBe(0);
  expect(x.planCopy, '两条引用 = **两次**复制（没有被去重成 1）').toBe(2);
  assertDirRefsLanded(x.name, { assets: 2, attachments: 0 });
  expect(x.files, 'assets/ 里两个文件').toHaveLength(2);
  expect(x.refs, '两条引用都挂在 images[] 上').toHaveLength(2);
  expect(new Set(x.refs).size, '两条**指向不同路径** —— 不是同一个文件被指两次').toBe(2);
  x.files.forEach((f) => expect(fs.readFileSync(path.join(projDir(x.name), 'assets', f)), f + ' 的字节等于源')
    .toEqual(pngBytes('good')));
  console.log('[批7 实测·' + label + '] copy=' + x.planCopy + ' ｜ assets=' + JSON.stringify(x.files)
    + ' ｜ images=' + JSON.stringify(x.refs) + ' ｜ 两条不同路径=' + (new Set(x.refs).size === 2));
}

/** 撞名 ⇒ 换一个**全新项目**重跑一次再判（见上面【批8】注）；不是撞名 ⇒ 直接判（含真缺陷） */
function twoRefCaseWithRetry(lib, name, label) {
  const x1 = readTwoRefCase(lib, name);
  if (!isNameCollision(x1)) { judgeTwoRefCase(x1, label); return; }
  console.log('[批8 撞名规避] ' + label + '：第一遍命中撞名签名（1/36⁴ ≈ 1/1.68M；两条引用必然同毫秒）'
    + ' ⇒ 用全新项目重跑一次；判据未放宽 —— 同形缺陷会连中两遍 ⇒ 必红');
  const x2 = readTwoRefCase(lib, name + '-r2');
  expect(isNameCollision(x2), '撞名不可能连续两次（1/1.68M 的平方）：第二遍仍是"两次复制落成一个名字"'
    + ' ⇒ 那是**系统性**的去重或命名缺陷，本组判据就是为它设的').toBe(false);
  judgeTwoRefCase(x2, label + '（撞名重跑第二遍）');
}

describe('【批7】E-① 一条引用一份副本、**不做内容去重**（同一张图被两处引用 ⇒ 两份）', () => {
  /* 判据两条（都在**真复制**那一跳上，不是"报告里写了什么"）：
   *   · `assets/` 里**两个**文件 + 两条 `images[].file` **指向不同路径**（⇒ 不是同一个文件被指两次）；
   *   · 两个文件**逐字节等于源**（⇒ 不是"登记了两条、盘上只落一份"或落了空壳）。
   * 判别力：把 `src/markdown.js` 的 `resolveImportRefs` 里 copy 那一段改成"按内容/按源路径去重"
   * （例如先 `if (seen.has(r.srcPath)) { r.entry.file = seen.get(r.srcPath); return; }`），
   * 或让 `collectResourceRefs` 先把同 `file` 的条目去重 ⇒ `assets/` 只剩 1 个、两条引用同一个名字
   * ⇒ 本组**必红**（计数、`Set` 基数、两条各不相同 三处都会红）。
   * 判别力（反向）：若复制那一步改成"只登记不复制"（不调 `copyFileSync`）⇒ 字节相等那两条与
   * `assertDirRefsLanded` 的"引用指向的文件必须真的在"**必红**。
   * **注入实测**（批7，2026-10；注入后撤销，三处源码 SHA-256 逐字节还原）：
   *   · 注入"copy 分支按源路径去重"（**跨项目共用名字**）⇒ 4 failed / 22：本组两条 + E-② 档2、档3；
   *   · 注入"只在**同一个项目目录**内按源路径去重" ⇒ 3 failed / 22：本组两条 + E-② 档3。
   *     （报文：`assets/ 里的文件: expected [ '…png' ] to have a length of 2 but got 1`） */
  it('同一文件两处引用同一张图 ⇒ assets/ 两个文件、两条 images[].file 指向**不同**路径、字节都等于源', () => {
    const lib = mkLibWith('e1-same', {
      '笔记/第一章.md': ['# 第一章', '', '![图：第一处](assets/good.png)', '',
        '![图：第二处](assets/good.png)', '', '正文一', '']
    });
    twoRefCaseWithRetry(lib, 'b7-e1-same', '边界①-同一文件两处');
  });

  it('两个文件各引用同一张图 ⇒ 同样两份（**跨文件**也不按内容去重）', () => {
    const lib = mkLibWith('e1-two', {
      '笔记/第一章.md': ['# 第一章', '', '![图：甲](assets/good.png)', '', '正文一', ''],
      '笔记/第二章.md': ['# 第二章', '', '![图：乙](assets/good.png)', '', '正文二', '']
    });
    twoRefCaseWithRetry(lib, 'b7-e1-two', '边界①-两个文件各一处');
  });
});

describe('【批7】E-② 同一来源连导两次（第二次 `--force`）⇒ 资源**会不会再多一份**？—— 三档实测', () => {
  /* 批6 登记的是"`--force` 重导会再复制一份资源"，字面读数 `assets/` **N → N+1**。
   * **实测与它不符**（本用例即取证）——`--force` 在 `import-dir` 上打不开"同一个项目再导一次"那扇门：
   *   `cli/commands/project.js` 的「项目已存在: <name>（换个名字，或先删掉它）」闸在 `--force`
   *   **之前**、也与它无关（那个字面量在闸的报文里，`--force` 不参与判断）⇒ 第二次无论带不带
   *   `--force` 都 exit 1，`assets/` 计数 **N → N**（一个字节都不多复制）。
   *   这条命令上 `--force` 解开的是**重复目录/重复文件**那道幂等闸（`refused = !!(dup || collisions.length)
   *   && !forced`）⇒ 它允许的是"同一来源导进**一个新项目**"，那时新项目里**又各复制一份**（全库 N → 2N）。
   *   `N → N+1` 只出现在**能往已有项目里再导一次**的那条命令上：`import-md --force`（同一份 md 追加两次）。
   * 三档都钉住 —— 后来人无论从哪条路问"会不会多一份"，都在这里读到实测答案（不用再翻交付说明）。
   * 判别力（逐档点名**哪一行坏了会让哪一条红**）：
   *   · 档1 ← `project.js` 的「项目已存在」闸（`if (fs.existsSync(path.join(ctx.PROJECTS_DIR, name, name + '.json')))`）：
   *     有人给 `--force` 开了绕过口 / 删掉这条闸 ⇒ 第二次会往下走并再复制一份 ⇒ 档1 的"N → N"必红；
   *   · 档2 ← 幂等闸那行 `&& !forced`（去掉 `!forced` 或 `forced` 恒 false）⇒ 第二次仍 exit 1 ⇒ 档2 必红；
   *     反向：若 `resolveImportRefs` 或整库那条开始**跨项目复用/去重**已有资源 ⇒ 新项目 `assets/` 计数 0 ⇒ 档2 必红；
   *   · 档3 ← 与边界①**同一处**（`markdown.js` 每次 copy 都新命名 + 真复制）：给单文件命令加"同项目同源复用"
   *     ⇒ 第二次 `assets/` 不涨 ⇒ 档3 的 N → N+1 必红。 */
  /* 三档**各一个用例**（不合成一条）：合在一起时前档一红就会**遮住后档**——实测注入
   * "copy 分支按源路径去重"时，档2 先红、档3 的读数根本没被报出来（判别力被掩盖）。
   * 拆开之后，谁坏了红的是哪一档，一眼能认。逐档**注入实测**（撤销后源码 SHA-256 逐字节还原）：
   *   · 档1 ← 让 `--force` 绕过「项目已存在」闸 ⇒ **只**档1 红（1 failed / 21，`expected +0 to be 1`）；
   *   · 档2 ← 把幂等闸那行的 `&& !forced` 改成 `&& true` ⇒ **只**档2 红（1 failed / 21，第二次 exit 1）；
   *   · 档3 ← 只在**同一个项目目录**内按源路径去重 ⇒ 档3 红（`expected [ '…png' ] to have a length of 2 but got 1`）。 */
  it('档1｜`import-dir` 同一项目名再导（带 `--force` 也一样）⇒ 被"项目已存在"闸拦下，assets/ 计数 N → N', () => {
    const lib = mkLibWith('e2-a', { '笔记/第一章.md': ['# 第一章', '', '![图](assets/good.png)', '', '正文', ''] });
    const A = 'b7-e2-a';
    expect(run(['import-dir', A, lib]).code).toBe(0);
    const a1 = assetsOf(A);
    expect(a1, '第一档起点：N=1').toHaveLength(1);
    const aAgain = run(['import-dir', A, lib, '--force']);
    expect(aAgain.code, '同一项目名再导 ⇒ 被"项目已存在"闸拦下（`--force` 不给它开口）').toBe(1);
    expect(aAgain.stdout).toContain('项目已存在');
    const a2 = assetsOf(A);
    expect(a2, 'assets/ 计数 N → N：一个字节都没多复制').toEqual(a1);
    console.log('[批7 实测·边界②档1] import-dir 同项目名（--force）：exit=' + aAgain.code
      + ' ｜ assets ' + a1.length + '→' + a2.length + ' ｜ 登记值"N+1"在这条路上不成立');
  });

  it('档2｜`import-dir` 同一来源换**新项目**：不带 `--force` 被幂等闸拒（零复制）｜带 `--force` ⇒ 新项目里又各复制一份（全库 N → 2N）', () => {
    const lib = mkLibWith('e2-b', { '笔记/第一章.md': ['# 第一章', '', '![图](assets/good.png)', '', '正文', ''] });
    const B1 = 'b7-e2-b1';
    const B2 = 'b7-e2-b2';
    const B3 = 'b7-e2-b3';
    expect(run(['import-dir', B1, lib]).code).toBe(0);
    const b1 = assetsOf(B1);
    expect(b1).toHaveLength(1);
    const bNo = run(['import-dir', B2, lib]);
    expect(bNo.code, '不带 `--force`：重复目录闸当场拒绝').toBe(1);
    expect(bNo.stdout).toMatch(/已经导入过/);
    expect(fs.existsSync(projFile(B2)), '被拒时项目文件一个字都没写').toBe(false);
    expect(assetsOf(B2), '被拒时一个资源都没复制（连目录都没建）').toBe(null);
    const bForced = run(['import-dir', B3, lib, '--force']);
    expect(bForced.code, bForced.stdout).toBe(0);
    const b3 = assetsOf(B3);
    expect(b3, '新项目里**又各复制一份**（计数与第一档同量级 N）').toHaveLength(b1.length);
    expect(b3, '靠**新名字**区分 ⇒ 不是复用第一份、也没有跨项目按内容去重').not.toEqual(b1);
    expect(fs.readFileSync(path.join(projDir(B3), 'assets', b3[0])), '第二份也是逐字节真复制').toEqual(pngBytes('good'));
    expect(assetsOf(B1), '第一份一字不动').toEqual(b1);
    console.log('[批7 实测·边界②档2] import-dir 换新项目（--force）：' + b1.length + '→' + b3.length
      + ' ｜ 两个项目各自一份 ⇒ 全库 2N（不是 N+1）');
  });

  it('档3｜`N → N+1` 的真路径：`import-md --force`（同一份 md 追加进**同一个项目**两次）', () => {
    const one = mkOneFile('e2-c');
    const C = 'b7-e2-c';
    expect(run(['init', C, '--title', '批7 单文件重导']).code).toBe(0);
    expect(run(['import-md', C, one]).code).toBe(0);
    const c1 = assetsOf(C);
    expect(c1, '起点 N=1').toHaveLength(1);
    const cNo = run(['import-md', C, one]);
    expect(cNo.code, '不带 `--force`：同一来源的幂等闸拒绝').toBe(1);
    expect(cNo.stdout).toMatch(/已经导入过/);
    const cForced = run(['import-md', C, one, '--force']);
    expect(cForced.code, cForced.stdout).toBe(0);
    const c2 = assetsOf(C);
    expect(c2, 'assets/ 计数第一次 N → 第二次 **N+1**（批6 那句登记值的真路径就在这里）')
      .toHaveLength(c1.length + 1);
    const cRefs = refsOf(C).map((x) => x.file);
    expect(cRefs, '两条 images[].file（两个来源节点各一份）').toHaveLength(2);
    expect(new Set(cRefs).size, '两条指向不同路径').toBe(2);
    cRefs.forEach((f) => expect(fs.readFileSync(path.join(projDir(C), f))).toEqual(pngBytes('good')));
    console.log('[批7 实测·边界②档3] import-md（--force）同项目：' + c1.length + '→' + c2.length
      + ' ｜ images=' + JSON.stringify(cRefs));
  });
});
