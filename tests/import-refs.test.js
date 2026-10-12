/* ============================================================
 * tests/import-refs.test.js — 【W19】导入 md 时图片/附件引用的落地
 * 运行：npx vitest run tests/import-refs.test.js
 * ------------------------------------------------------------
 * ## 守什么（每条都对着一个**能红**的判据）
 *   A. **能解析到源文件** ⇒ 文件真被复制进 `projects/<项目>/assets|attachments/`（内容逐字节相同），
 *      且 `images[].file` / `files[].file` 是**项目内**相对路径。
 *      旧行为（本项要修的缺陷）：md 里的原样字符串直接落盘 ⇒ 悬空引用，而 exit 0、回显里一个字都没说。
 *      取证（本次临时沙箱实测，改动前）：`images[].file = "assets/x.png"`、`assets/` 目录**不存在**、
 *      而 `validate` **照样通过** —— 所以"validate 绿"证明不了不留坏引用，必须同时看**文件在不在**。
 *   B. **解析不到源文件** ⇒ 逐条如实报告（哪个节点 / 哪一条引用 / 原样路径 / 按序试过哪些路径 / 出路），
 *      并**拒绝整份导入**：盘上既没有悬空引用，也没有半份项目、没有多出来的资源文件。
 *      （选择"拒绝"而不是"跳过该条"的理由写在 `cli/commands/project.js` 的 `refBlockedError` 上。）
 *   C. **注入证明**（判别力）：把"复制 + 校验"那一步打桩成**旧行为**（原样登记、不复制、不校验）
 *      ⇒ A / B 用的**同一批断言必红**（证明它们真会抓，而不是"看起来测了"）。
 *   D. 与 `add-image` **同一条规则**：图片扩展名白名单、命名表达式 —— 两条**防漂移**断言把
 *      `src/markdown.js` 与 `cli/commands/assets.js` 的两处表达钉在一起（改一处不改另一处必红）。
 *   E. **非本地引用**（`https:` / `data:`）⇒ 不挂进 `images/files`（`file` 的规范是项目内相对路径），
 *      那一行**按正文**并入节点 detail（内容不丢）、不阻断导入、逐条点名。
 *   F. `import-project --dry-run` 只预览：**不复制、不建目录、不改数据**，且与真导**同一份判据**
 *      （有坏引用 ⇒ `wouldRefuse=true`，真导确实被拒）。
 *   G. **一处实现**：两条命令调 `src/markdown.js` 同一个函数（源码级断言：2 处调用 / 1 处定义 /
 *      资源行语法只有 1 个字面量）—— W12（Obsidian 直进）将来复用的就是这一份。
 *   H. **沙箱自证**：`AI_MINDMAP_PROJECTS_DIR` 必须在 require CLI **之前**生效，不生效就**当场红**
 *      （夹具写进真实 `projects/` 是本文件可能犯的最坏的错）。
 * ## 环境要点
 *   · 端到端一律走**进程内** `invokeSync`（同 tests/item-commands.test.js），不起子进程；
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
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-w19-sbx-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-w19-work-'));
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const markdown = require('../src/markdown.js');

if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效（cli/core.js 已被更早加载）：PROJECTS_DIR='
    + core.PROJECTS_DIR + ' 期望=' + SANDBOX + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (argv) => invokeSync(argv);

/* ---- ② 夹具：图片/附件与 md（内容带标记 ⇒ 可断言"复制的是这一份"） ---- */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngBytes(tag) { return Buffer.concat([PNG_MAGIC, Buffer.from('#' + tag, 'utf8')]); }
function textBytes(tag) { return Buffer.from('# ' + tag + '\n附件正文\n', 'utf8'); }

/** 造一个"md 与 assets/、attachments/ 同目录"的源目录（= export-md 文件夹导出的布局） */
function mkSource(label) {
  const dir = path.join(WORK, label);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
  return dir;
}
function writeMd(dir, name, lines) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, lines.join('\n'), 'utf8');
  return f;
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
/** 悬空引用 = `file` 不是项目内路径，或那个文件在盘上不存在（旧行为下必然非空） */
function danglingOf(name) {
  return refsOf(name).filter((r) => !fs.existsSync(path.join(projDir(name), r.file)));
}
/** 节点详情里有没有这段文本（用来验"那一行按正文保留了"） */
function detailsOf(name) {
  const out = [];
  (function w(n) { if (!n) return; if (n.detail) out.push(n.detail); (n.children || []).forEach(w); })(readProj(name).data);
  return out.join('\n');
}

/**
 * **验收①的判据本身**（正向断言与注入证明共用同一个函数 —— 打桩成旧行为时它必须红）。
 * @param {string} name 项目名
 * @param {{assets:number, attachments:number}} want 期望的项目内文件数
 */
function assertRefsLanded(name, want) {
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
}

/** 项目目录里某个文件的字节（用来断言"复制的就是源文件那一份"） */
function bytesInProject(name, rel) { return fs.readFileSync(path.join(projDir(name), rel)); }
const relOf = (refs, i, kind) => refs.filter((r) => r.kind === kind)[i].file;

/** **验收②的判据本身**（与 `assertRefsLanded` 对称，注入证明共用）：坏引用必须被**拒绝且点名**。 */
function assertRefused(r) {
  expect(r.code, '坏引用必须非 0（不许静默写脏）：' + r.stdout).toBe(1);
  expect(r.stdout).toContain('error:');
  expect(r.stdout).toContain('源文件不存在');
  expect(r.stdout).toContain('没有写盘');
}

afterAll(() => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* 清不掉不影响结论 */ }
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* 同上 */ }
});

/* ============================================================================
 * A. 能解析到源文件 ⇒ 复制进项目 + 引用写项目内相对路径
 * ========================================================================== */
describe('【W19】A. 能解析到源文件：复制进项目（images/files 指向项目内）', () => {
  let src;
  let mdFile;
  beforeAll(() => {
    src = mkSource('a');
    fs.writeFileSync(path.join(src, 'assets', 'x.png'), pngBytes('x'));
    fs.writeFileSync(path.join(src, 'attachments', 'note.md'), textBytes('note'));
    mdFile = writeMd(src, 'book.md', [
      '# 第一章', '', '![图：示意图](assets/x.png)', '', '正文一段。', '',
      '# 第二章', '', '[📎 附录 — attachments/note.md](attachments/note.md)', '', '正文二段。', ''
    ]);
  });

  it('import-project：图片/附件都复制进项目，引用是项目内相对路径（内容逐字节相同）', () => {
    const r = run(['import-project', 'w19-a', mdFile]);
    expect(r.code, r.stdout).toBe(0);
    assertRefsLanded('w19-a', { assets: 1, attachments: 1 });

    const refs = refsOf('w19-a');
    expect(refs.map((x) => x.kind).sort()).toEqual(['file', 'image']);
    // 复制的是**那一份**文件（不是空壳/占位）：字节相同
    expect(bytesInProject('w19-a', relOf(refs, 0, 'image'))).toEqual(pngBytes('x'));
    expect(bytesInProject('w19-a', relOf(refs, 0, 'file'))).toEqual(textBytes('note'));
    // 旧行为残留的判据：原样字符串（`assets/x.png`）**不许**再出现在数据里
    const json = fs.readFileSync(projFile('w19-a'), 'utf8');
    expect(json).not.toContain('"assets/x.png"');
    expect(json).not.toContain('"attachments/note.md"');
    // 如实报告：复制了几条、复制成了什么
    expect(r.stdout).toContain('已复制 2 个文件进项目');
    expect(r.stdout).toContain('assets/');
    expect(r.stdout).toContain('attachments/');
  });

  it('import-md：追加导入走同一条路（同一个函数），引用同样落进项目', () => {
    expect(run(['init', 'w19-a2']).code).toBe(0);
    const r = run(['import-md', 'w19-a2', mdFile, '--parent', 'root']);
    expect(r.code, r.stdout).toBe(0);
    assertRefsLanded('w19-a2', { assets: 1, attachments: 1 });
    expect(r.stdout).toContain('已复制 2 个文件进项目');
  });

  it('同一份 md 导两次（--force）会各复制一份，但两条引用都指向**真实存在**的文件', () => {
    const before = listDir(path.join(projDir('w19-a2'), 'assets')).length;
    const r = run(['import-md', 'w19-a2', mdFile, '--parent', 'root', '--force']);
    expect(r.code, r.stdout).toBe(0);
    expect(listDir(path.join(projDir('w19-a2'), 'assets')).length).toBe(before + 1);
    assertRefsLanded('w19-a2', { assets: 2, attachments: 2 });
  });
});

/* ============================================================================
 * B. 解析不到源文件 ⇒ 如实报告 + 拒绝整份导入（盘上没有悬空引用）
 * ========================================================================== */
describe('【W19】B. 解析不到 ⇒ 逐条如实报告 + 拒绝整份导入（盘上不留悬空引用）', () => {
  let src;
  let badMd;
  let badAttMd;
  beforeAll(() => {
    src = mkSource('b');
    badMd = writeMd(src, 'bad.md', ['# 第一章', '', '![图：丢了的图](assets/gone.png)', '', '正文。', '']);
    badAttMd = writeMd(src, 'bad-att.md', ['# 附录章', '', '[📎 缺的附件 — attachments/gone.md](attachments/gone.md)', '']);
  });

  it('import-md：非 0；逐条点名（节点/引用/原样路径/试过的路径/出路）；项目文件逐字节不变', () => {
    expect(run(['init', 'w19-b1']).code).toBe(0);
    const before = fs.readFileSync(projFile('w19-b1'), 'utf8');
    const r = run(['import-md', 'w19-b1', badMd, '--parent', 'root']);
    assertRefused(r);
    expect(r.stdout).toContain('节点「第一章」');                       // 哪个节点
    expect(r.stdout).toContain('（图片）assets/gone.png');              // 哪一条引用 + 原样路径
    expect(r.stdout).toContain('按序试过：');                            // 试过哪些路径
    expect(r.stdout).toContain('add-image');                           // 出路里给出可执行命令
    expect(r.stdout).toContain('https://');                            // 另一条出路（改成远程引用）
    expect(r.stdout).toContain('--force 不能绕过这道闸');
    // 盘上：一个字节都没动 + 没有 assets/ 目录 + 没有悬空引用
    expect(fs.readFileSync(projFile('w19-b1'), 'utf8')).toBe(before);
    expect(listDir(path.join(projDir('w19-b1'), 'assets'))).toBe(null);
    expect(danglingOf('w19-b1')).toEqual([]);
  });

  it('import-project：非 0；项目目录**根本不存在**（不留半份项目、不留半份资源）', () => {
    const r = run(['import-project', 'w19-b2', badMd]);
    expect(r.code, r.stdout).toBe(1);
    expect(r.stdout).toContain('节点「第一章」');
    expect(r.stdout).toContain('assets/gone.png');
    expect(fs.existsSync(projDir('w19-b2'))).toBe(false);
    expect(fs.existsSync(projFile('w19-b2'))).toBe(false);
  });

  it('附件缺失同一口径（不是只管图片）', () => {
    expect(run(['init', 'w19-b3']).code).toBe(0);
    const before = fs.readFileSync(projFile('w19-b3'), 'utf8');
    const r = run(['import-md', 'w19-b3', badAttMd, '--parent', 'root']);
    assertRefused(r);
    expect(r.stdout).toContain('节点「附录章」');
    expect(r.stdout).toContain('（附件）attachments/gone.md');
    expect(fs.readFileSync(projFile('w19-b3'), 'utf8')).toBe(before);
  });

  it('一份文档里同时有"能解析的"和"解析不到的" ⇒ 整份拒绝，且**能解析的那条也不复制**（拒绝是干净的）', () => {
    const dir = mkSource('b-mix');
    fs.writeFileSync(path.join(dir, 'assets', 'ok.png'), pngBytes('ok'));
    const md = writeMd(dir, 'mix.md', [
      '# 第一章', '', '![图：好的](assets/ok.png)', '',
      '# 第二章', '', '![图：坏的](assets/gone.png)', ''
    ]);
    expect(run(['init', 'w19-b4']).code).toBe(0);
    const r = run(['import-md', 'w19-b4', md, '--parent', 'root']);
    expect(r.code, r.stdout).toBe(1);
    expect(r.stdout).toContain('assets/gone.png');
    expect(r.stdout).not.toContain('assets/ok.png');       // 好的那条也一个字不提（没落地）
    expect(listDir(path.join(projDir('w19-b4'), 'assets'))).toBe(null);
    expect(fs.readFileSync(projFile('w19-b4'), 'utf8')).not.toContain('ok.png');
  });
});

/* ============================================================================
 * C. 注入证明：把"复制 + 校验"换成旧行为 ⇒ 同一批断言必红
 * ========================================================================== */
describe('【W19】C. 注入证明（判别力）：还原旧行为 ⇒ A/B 的断言必红', () => {
  /** 旧行为替身：原样登记引用、不复制、不校验（= 改动前 `parseResource` 产物直接落盘） */
  const OLD_BEHAVIOR = () => ({
    ok: true, applied: false, dryRun: false, onMissing: 'refuse',
    refs: [], blocked: [], copied: [], inProject: [], remote: [], dropped: []
  });

  it('A 类断言：打桩成旧行为 ⇒ exit 0 却留下悬空引用，`assertRefsLanded` 必红', () => {
    const dir = mkSource('c-a');
    fs.writeFileSync(path.join(dir, 'assets', 'x.png'), pngBytes('x'));
    const md = writeMd(dir, 'c.md', ['# 第一章', '', '![图：示意图](assets/x.png)', '']);
    const real = markdown.resolveImportRefs;
    markdown.resolveImportRefs = OLD_BEHAVIOR;
    try {
      const r = run(['import-project', 'w19-c1', md]);
      expect(r.code, '旧行为：照样"成功"（这正是缺陷的样子）').toBe(0);
      expect(danglingOf('w19-c1'), '旧行为：悬空引用落盘').not.toEqual([]);
      expect(listDir(path.join(projDir('w19-c1'), 'assets')), '旧行为：文件从来没被复制').toBe(null);
      expect(() => assertRefsLanded('w19-c1', { assets: 1, attachments: 0 })).toThrow();   // ← 必红
    } finally {
      markdown.resolveImportRefs = real;
    }
  });

  it('B 类断言：打桩成旧行为 ⇒ 坏引用**不再被拒**、静默写脏，拒绝类断言必红', () => {
    const dir = mkSource('c-b');
    const md = writeMd(dir, 'c-bad.md', ['# 第一章', '', '![图：丢了的图](assets/gone.png)', '']);
    expect(run(['init', 'w19-c2']).code).toBe(0);
    const real = markdown.resolveImportRefs;
    markdown.resolveImportRefs = OLD_BEHAVIOR;
    try {
      const r = run(['import-md', 'w19-c2', md, '--parent', 'root']);
      expect(r.code, '旧行为：exit 0（这正是"静默写脏"的样子）').toBe(0);
      expect(() => assertRefused(r)).toThrow();                       // ← 必红（同一批断言）
      expect(danglingOf('w19-c2'), '旧行为：坏引用落盘了').not.toEqual([]);
    } finally {
      markdown.resolveImportRefs = real;
    }
  });

  it('打桩已复原：同一份夹具在真实现下恢复"拒"与"落地"两条行为（证明上一条红的是断言、不是环境）', () => {
    expect(markdown.resolveImportRefs).not.toBe(OLD_BEHAVIOR);
    const dir = mkSource('c-restore');
    fs.writeFileSync(path.join(dir, 'assets', 'x.png'), pngBytes('x'));
    const md = writeMd(dir, 'r.md', ['# 第一章', '', '![图：示意图](assets/x.png)', '']);
    expect(run(['import-project', 'w19-c3', md]).code).toBe(0);
    assertRefsLanded('w19-c3', { assets: 1, attachments: 0 });
  });
});

/* ============================================================================
 * D. 与 add-image 同一条规则（防漂移断言 + 图片格式闸）
 * ========================================================================== */
describe('【W19】D. 与 cli/commands/assets.js 同一条规则（命名 / 图片格式白名单）', () => {
  const assetsSrc = fs.readFileSync(path.join(REPO, 'cli', 'commands', 'assets.js'), 'utf8');
  const mdSrc = fs.readFileSync(path.join(REPO, 'src', 'markdown.js'), 'utf8');
  const NAME_EXPR = 'Date.now().toString(36) + Math.random().toString(36).slice(2, 6)';
  const EXT_RE_SRC = '/\\.(png|jpe?g|gif|webp|svg|bmp)$/';

  it('命名表达式逐字一致（两处表达已被钉住；哪天抽成单一函数，这条断言会提醒改）', () => {
    expect(assetsSrc).toContain(NAME_EXPR);
    expect(mdSrc).toContain(NAME_EXPR);
  });

  it('图片扩展名白名单逐字一致，且"人话版"与正则不漂移', () => {
    expect(assetsSrc).toContain(EXT_RE_SRC);
    expect(mdSrc).toContain(EXT_RE_SRC);
    expect(markdown.IMAGE_EXT_RE.source).toBe('\\.(png|jpe?g|gif|webp|svg|bmp)$');
    markdown.IMAGE_EXT_TEXT.split('/').forEach((e) => {
      expect(markdown.IMAGE_EXT_RE.test('.' + e), '白名单里写了但正则不认: .' + e).toBe(true);
    });
    ['tiff', 'avif', 'ico', 'pdf'].forEach((e) => {
      expect(markdown.IMAGE_EXT_RE.test('.' + e)).toBe(false);
    });
  });

  it('`.tiff` 图片：拒绝整份导入并说清格式规则（与 add-image 的"不支持的图片格式"同一条）', () => {
    const dir = mkSource('d-img');
    fs.writeFileSync(path.join(dir, 'assets', 'pic.tiff'), pngBytes('tiff'));
    const md = writeMd(dir, 'tiff.md', ['# 图稿章', '', '![图：扫描稿](assets/pic.tiff)', '']);
    expect(run(['init', 'w19-d1']).code).toBe(0);
    const before = fs.readFileSync(projFile('w19-d1'), 'utf8');
    const r = run(['import-md', 'w19-d1', md, '--parent', 'root']);
    expect(r.code, r.stdout).toBe(1);
    expect(r.stdout).toContain('不是受支持的图片格式: .tiff');
    expect(r.stdout).toContain(markdown.IMAGE_EXT_TEXT);
    expect(r.stdout).toContain('add-file');                    // 出路：当附件挂
    expect(fs.readFileSync(projFile('w19-d1'), 'utf8')).toBe(before);
  });

  it('同一个 `.tiff` 当**附件**（📎 行）⇒ 照常复制进 attachments/（附件不限格式）', () => {
    const dir = mkSource('d-att');
    fs.writeFileSync(path.join(dir, 'attachments', 'pic.tiff'), pngBytes('tiff-att'));
    const md = writeMd(dir, 'att.md', ['# 图稿章', '', '[📎 扫描稿 — attachments/pic.tiff](attachments/pic.tiff)', '']);
    expect(run(['init', 'w19-d2']).code).toBe(0);
    const r = run(['import-md', 'w19-d2', md, '--parent', 'root']);
    expect(r.code, r.stdout).toBe(0);
    assertRefsLanded('w19-d2', { assets: 0, attachments: 1 });
    expect(bytesInProject('w19-d2', relOf(refsOf('w19-d2'), 0, 'file'))).toEqual(pngBytes('tiff-att'));
  });
});

/* ============================================================================
 * E. 非本地引用：不挂进 images/files，按正文保留 + 逐条点名
 * ========================================================================== */
describe('【W19】E. 非本地引用（远程 / data:）：按正文保留，不落成"项目内路径形状"的坏引用', () => {
  it('https + data: 两条 ⇒ 导入成功、images 里没有它们、那一行进了 detail、报告点名', () => {
    const dir = mkSource('e');
    const md = writeMd(dir, 'remote.md', [
      '# 外链章', '', '![图：外链](https://example.com/a.png)', '',
      '![图：占位](data:image/gif;base64,R0lGODlhAQABAPABAP)', ''
    ]);
    const r = run(['import-project', 'w19-e1', md]);
    expect(r.code, r.stdout).toBe(0);
    expect(refsOf('w19-e1'), '远程引用不许挂进 images/files').toEqual([]);
    expect(listDir(path.join(projDir('w19-e1'), 'assets'))).toBe(null);      // 没复制任何东西
    // 内容不丢：那一行按正文（HTML）留在节点详情里
    const detail = detailsOf('w19-e1');
    expect(detail).toContain('https://example.com/a.png');
    expect(detail).toContain('data:image/gif');
    // 逐条点名 + 说清"去哪了"
    expect(r.stdout).toContain('非本地引用 2 条（按正文保留）');
    expect(r.stdout).toContain('https://example.com/a.png');
    expect(r.stdout).toContain('data:image/gif');
    expect(r.stdout).toContain('详情');
    expect(run(['validate', 'w19-e1']).code).toBe(0);
  });

  it('远程引用不阻断导入：同一份文档里"能解析的图片"照常复制、远程那条按正文保留', () => {
    const dir = mkSource('e-mix');
    fs.writeFileSync(path.join(dir, 'assets', 'local.png'), pngBytes('local'));
    const md = writeMd(dir, 'mix.md', [
      '# 混合章', '', '![图：本地](assets/local.png)', '', '![图：外链](https://example.com/b.png)', ''
    ]);
    const r = run(['import-project', 'w19-e2', md]);
    expect(r.code, r.stdout).toBe(0);
    assertRefsLanded('w19-e2', { assets: 1, attachments: 0 });
    expect(refsOf('w19-e2')[0].file).toMatch(/^assets\//);
    expect(r.stdout).toContain('已复制 1 个文件进项目');
    expect(r.stdout).toContain('非本地引用 1 条');
    expect(detailsOf('w19-e2')).toContain('https://example.com/b.png');
  });
});

/* ============================================================================
 * F. import-project --dry-run：只预览（不复制/不建目录）且与真导同一判据
 * ========================================================================== */
describe('【W19】F. `import-project --dry-run`：预览不写盘、不复制，且与真导同一份判据', () => {
  function dryJson(name, md) {
    const r = run(['import-project', name, md, '--dry-run', '--json']);
    expect(r.code, r.stdout).toBe(0);
    return JSON.parse(r.stdout);
  }

  it('引用都解析得到 ⇒ 预览报 copy=1 且**没复制、没建项目目录**；真导才复制', () => {
    const dir = mkSource('f-ok');
    fs.writeFileSync(path.join(dir, 'assets', 'x.png'), pngBytes('x'));
    const md = writeMd(dir, 'ok.md', ['# 第一章', '', '![图：示意图](assets/x.png)', '']);
    const j = dryJson('w19-f1', md);
    expect(j.dryRun).toBe(true);
    expect(j.wouldRefuse).toBe(false);
    expect(j.resourceRefs).toMatchObject({ total: 1, copy: 1, missing: 0, badExt: 0 });
    expect(fs.existsSync(projDir('w19-f1')), 'dry-run 不许建项目目录').toBe(false);

    const r = run(['import-project', 'w19-f1', md]);
    expect(r.code, r.stdout).toBe(0);
    assertRefsLanded('w19-f1', { assets: 1, attachments: 0 });
  });

  it('有坏引用 ⇒ 预览 wouldRefuse=true、逐条列出试过的路径；真导确实被拒（预览与真导同一判据）', () => {
    const dir = mkSource('f-bad');
    const md = writeMd(dir, 'bad.md', ['# 第一章', '', '![图：丢了](assets/gone.png)', '']);
    const j = dryJson('w19-f2', md);
    expect(j.wouldRefuse, '预览必须说"真导会被拒"（免得预览说能导、真导被拒）').toBe(true);
    expect(j.resourceRefs.missing).toBe(1);
    expect(j.resourceRefs.blocked[0].ref).toBe('assets/gone.png');
    expect(j.resourceRefs.blocked[0].topic).toBe('第一章');
    expect(j.resourceRefs.blocked[0].tried.length).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(projDir('w19-f2'))).toBe(false);

    const r = run(['import-project', 'w19-f2', md]);
    expect(r.code, r.stdout).toBe(1);
    expect(r.stdout).toContain('assets/gone.png');
  });

  it('dry-run 的人类可读回显也逐条说明（不是只有 JSON 才看得见）', () => {
    const dir = mkSource('f-text');
    fs.writeFileSync(path.join(dir, 'assets', 'x.png'), pngBytes('x'));
    const md = writeMd(dir, 't.md', ['# 第一章', '', '![图：示意图](assets/x.png)', '']);
    const r = run(['import-project', 'w19-f3', md, '--dry-run']);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain('资源引用（共 1 条）');
    expect(r.stdout).toContain('将复制 1 个文件进项目');
    expect(r.stdout).toContain('（以上是**预览**');
    expect(fs.existsSync(projDir('w19-f3'))).toBe(false);
  });
});

/* ============================================================================
 * G. export-md 往返：引用已在项目内 ⇒ 不重复复制
 * ========================================================================== */
describe('【W19】G. 引用本来就指向项目内的文件（export-md 往返）⇒ 原样保留、不复制', () => {
  it('导出的 md 再导回同一个项目：assets/ 不涨、引用指向同一个文件', () => {
    expect(run(['init', 'w19-g']).code).toBe(0);
    const dir = mkSource('g');
    fs.writeFileSync(path.join(dir, 'assets', 'orig.png'), pngBytes('orig'));
    const add = run(['add-image', 'w19-g', 'root', '--file', path.join(dir, 'assets', 'orig.png'), '--caption', '原图']);
    expect(add.code, add.stdout).toBe(0);
    const first = refsOf('w19-g')[0].file;
    expect(first).toMatch(/^assets\//);
    const filesBefore = listDir(path.join(projDir('w19-g'), 'assets'));

    const out = path.join(WORK, 'g-export');
    expect(run(['export-md', 'w19-g', out]).code).toBe(0);
    const r = run(['import-md', 'w19-g', path.join(out, 'w19-g.md'), '--parent', 'root']);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain('已在项目内，未复制');
    expect(listDir(path.join(projDir('w19-g'), 'assets')), '不许再复制一份').toEqual(filesBefore);
    expect(refsOf('w19-g').map((x) => x.file).sort()).toEqual([first, first]);
    expect(danglingOf('w19-g')).toEqual([]);
  });

  it('`./assets/x.png` 这种写法在项目内命中时规范化成 `assets/x.png`（解析器单元级）', () => {
    expect(run(['init', 'w19-g2']).code).toBe(0);
    const dir = mkSource('g2');
    fs.writeFileSync(path.join(dir, 'assets', 'x.png'), pngBytes('x'));
    expect(run(['add-image', 'w19-g2', 'root', '--file', path.join(dir, 'assets', 'x.png'), '--caption', '图'])
      .code).toBe(0);
    const name = refsOf('w19-g2')[0].file;
    const tree = [{ id: 'n1', topic: '章', images: [{ file: './' + name, caption: 'c' }] }];
    const rep = markdown.resolveImportRefs(tree, {
      baseDir: dir,
      projectDir: projDir('w19-g2'),
      assetDir: () => path.join(projDir('w19-g2'), 'assets'),
      attachmentDir: () => path.join(projDir('w19-g2'), 'attachments')
    });
    expect(rep.ok).toBe(true);
    expect(rep.inProject).toHaveLength(1);
    expect(tree[0].images[0].file).toBe(name);          // `./` 被规范化掉
  });
});

/* ============================================================================
 * H. 解析器本身（单元级）：原子性、onMissing:'detail' 这个"不阻断"口径、Windows 盘符不误判
 * ========================================================================== */
describe('【W19】H. `resolveImportRefs` 的契约（单元级）', () => {
  const dirOpts = (name) => ({
    assetDir: () => path.join(projDir(name), 'assets'),
    attachmentDir: () => path.join(projDir(name), 'attachments')
  });

  it('有一条解析不到 ⇒ ok:false 且**整棵树一个字段都不改**、**一个目录都不建**（拒绝是干净的）', () => {
    const dir = mkSource('h-atomic');
    fs.writeFileSync(path.join(dir, 'assets', 'ok.png'), pngBytes('ok'));
    const tree = [{
      id: 'n1', topic: '章', images: [{ file: 'assets/ok.png', caption: 'a' }, { file: 'assets/gone.png', caption: 'b' }]
    }];
    expect(run(['init', 'w19-h1']).code).toBe(0);
    const rep = markdown.resolveImportRefs(tree, Object.assign({ baseDir: dir, projectDir: projDir('w19-h1') }, dirOpts('w19-h1')));
    expect(rep.ok).toBe(false);
    expect(rep.applied).toBe(false);
    expect(rep.blocked.map((r) => r.raw)).toEqual(['assets/gone.png']);
    expect(tree[0].images.map((i) => i.file)).toEqual(['assets/ok.png', 'assets/gone.png']);   // 原地没动
    expect(listDir(path.join(projDir('w19-h1'), 'assets'))).toBe(null);                       // 连目录都没建
  });

  it('`onMissing:"detail"`（预备给整库导入的口径）⇒ 不阻断：坏引用摘出来按正文保留、好的照常复制', () => {
    const dir = mkSource('h-detail');
    fs.writeFileSync(path.join(dir, 'assets', 'ok.png'), pngBytes('ok'));
    const tree = [{
      id: 'n1', topic: '章', images: [{ file: 'assets/ok.png', caption: 'a' }, { file: 'assets/gone.png', caption: 'b' }]
    }];
    expect(run(['init', 'w19-h2']).code).toBe(0);
    const rep = markdown.resolveImportRefs(tree,
      Object.assign({ baseDir: dir, projectDir: projDir('w19-h2'), onMissing: 'detail' }, dirOpts('w19-h2')));
    expect(rep.ok).toBe(true);
    expect(rep.dropped.map((r) => r.raw)).toEqual(['assets/gone.png']);
    expect(tree[0].images).toHaveLength(1);
    expect(tree[0].images[0].file).toMatch(/^assets\//);
    expect(tree[0].detail).toContain('assets/gone.png');       // 内容不丢
    expect(listDir(path.join(projDir('w19-h2'), 'assets'))).toHaveLength(1);
  });

  it('Windows 盘符**不**被当成 URL 协议（`C:\\…` 是本地绝对路径 ⇒ 会复制；`https://…` ⇒ 远程）', () => {
    const dir = mkSource('h-drive');
    const abs = path.join(dir, 'assets', 'drive.png');
    fs.writeFileSync(abs, pngBytes('drive'));
    expect(run(['init', 'w19-h3']).code).toBe(0);
    const tree = [{ id: 'n1', topic: '章', images: [{ file: abs, caption: 'a' }, { file: 'https://e.com/a.png', caption: 'b' }] }];
    const rep = markdown.resolveImportRefs(tree, Object.assign({ baseDir: dir, projectDir: projDir('w19-h3') }, dirOpts('w19-h3')));
    expect(rep.ok).toBe(true);
    expect(rep.copied.map((r) => r.srcPath)).toEqual([abs]);
    expect(rep.remote.map((r) => r.raw)).toEqual(['https://e.com/a.png']);
    expect(tree[0].images.map((i) => i.file)[0]).toMatch(/^assets\//);
    expect(tree[0].images).toHaveLength(1);                    // 远程那条被摘出去了
    expect(tree[0].detail).toContain('https://e.com/a.png');
  });

  it('dryRun:true ⇒ 规划齐全但零副作用（不复制、不改树、不建目录）', () => {
    const dir = mkSource('h-dry');
    fs.writeFileSync(path.join(dir, 'assets', 'x.png'), pngBytes('x'));
    expect(run(['init', 'w19-h4']).code).toBe(0);
    const tree = [{ id: 'n1', topic: '章', images: [{ file: 'assets/x.png', caption: 'a' }] }];
    const rep = markdown.resolveImportRefs(tree,
      Object.assign({ baseDir: dir, projectDir: projDir('w19-h4'), dryRun: true }, dirOpts('w19-h4')));
    expect(rep.ok).toBe(true);
    expect(rep.copied).toHaveLength(1);
    expect(rep.copied[0].dest).toBe(null);
    expect(tree[0].images[0].file).toBe('assets/x.png');
    expect(listDir(path.join(projDir('w19-h4'), 'assets'))).toBe(null);
  });
});

/* ============================================================================
 * I. 一处实现（源码级把守）+ 沙箱自证
 * ========================================================================== */
describe('【W19】I. 一处实现与沙箱自证', () => {
  const cmdSrc = fs.readFileSync(path.join(REPO, 'cli', 'commands', 'project.js'), 'utf8');
  const mdSrc = fs.readFileSync(path.join(REPO, 'src', 'markdown.js'), 'utf8');

  it('两条导入命令调的是 `src/markdown.js` 的**同一个函数**（4 处调用 / 1 处定义）', () => {
    // import-project 调 2 次（dry-run 的规划 + 真导的落地）、import-md 调 1 次；
    // 【批6】import-dir 调 1 次 —— 在唯一的 `resolveDirImportRefs` 里**逐文件**调同一个函数
    //（口径两样、实现一处：为什么整库选 "detail" 见 src/doc-import.js 的 ⓪⁗ 契约段）
    expect((cmdSrc.match(/markdown\.resolveImportRefs\(/g) || [])).toHaveLength(4);
    expect((mdSrc.match(/function resolveImportRefs\(/g) || [])).toHaveLength(1);     // 实现只有这一处
    expect(cmdSrc).toContain('refResolveOpts(ctx, name, file)');
    expect(cmdSrc).toContain('refResolveOpts(ctx, ctx.projectName, file)');
    // 整库那条的调用点**只有一处**，且与上面两条共用一个函数（不是另写一份复制/改名）
    expect((cmdSrc.match(/function resolveDirImportRefs\(/g) || [])).toHaveLength(1);
  });

  it('资源行的语法只有 1 个字面量（`resourceLine`）——导出与"降级成正文"不会各写一套', () => {
    expect((mdSrc.match(/'!\[图：'/g) || [])).toHaveLength(1);
    // 两处调用点都走它：treeToMarkdown 的写出 + 解析器把引用降级成正文
    expect(mdSrc).toContain("out.push(resourceLine('image', img.file, img.caption))");
    expect(mdSrc).toContain('convert.markdownToHtml(resourceLine(r.kind, r.raw, r.caption))');
  });

  it('资源行写出 ⇄ 解析成对（逐字钉住：改一个字，导出/导入就不再互换）', () => {
    const t = {
      id: 'r', topic: 'T', children: [],
      images: [{ file: 'assets/a.png', caption: '示意图' }],
      files: [{ file: 'attachments/x.md', caption: '附录' }]
    };
    const lines = markdown.treeToMarkdown(t, { withResources: true }).split('\n');
    expect(lines).toContain('![图：示意图](assets/a.png)');
    expect(lines).toContain('[📎 附录 — attachments/x.md](attachments/x.md)');
    // 写出来的两行再解析回来 ⇒ 引用一字不差（成对）
    const back = markdown.markdownToTree(lines.join('\n'), 'root');
    const n = back.data.children[0];
    expect(n.images).toEqual([{ file: 'assets/a.png', caption: '示意图' }]);
    expect(n.files).toEqual([{ file: 'attachments/x.md', caption: '附录' }]);
  });

  it('沙箱自证：项目根在临时目录里，真实 `projects/` 全程零接触', () => {
    expect(path.resolve(core.PROJECTS_DIR)).toBe(path.resolve(SANDBOX));
    expect(path.resolve(SANDBOX).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    expect(path.resolve(WORK).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    // 本项目下所有被测项目都落在沙箱里
    listDir(SANDBOX).forEach((n) => expect(path.resolve(projDir(n)).startsWith(path.resolve(SANDBOX))).toBe(true));
  });
});
