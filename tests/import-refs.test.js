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
 *   J.【批8】`import-project` 的**同款边界三档**（对照 `import-dir` 的 E 组）：同一项目名再导 /
 *      换新项目 + `--force` / 「往已有项目追加」这一档在本命令上**不可达** —— 判据与逐档读数见文件末尾。
 *   K.【批9】资源新名字的**唯一性闸**（产品侧已修）：同一毫秒的两条引用**不许互相覆盖** ——
 *      撞名 ⇒ 只换名字、内容仍是那份源文件、**绝不覆盖**已有文件、重摇有上界（连撞就响亮报错）；
 *      不撞名 ⇒ 命名与从前**逐字节相同**。判据 T1..T4 与逐条判别力（含"修前必红 / 去掉闸必红"的
 *      注入记录）见文件末尾的【批9】组注。
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

/* ============================================================================
 * J. 【批8】`import-project` 的**同款边界三档**（对照 `import-dir` 的 E 组）
 * ==========================================================================
 * 批7 把 `import-dir` 的边界实测钉进了 `tests/import-dir-refs.test.js` 的 E 组，并在交付里
 * **如实登记 `import-project` 未实测**。本组补上那一份，逐档与 E 组对齐（同样**进程内**
 * `invokeSync` + `AI_MINDMAP_PROJECTS_DIR` 沙箱；不起子进程、不碰真实 `projects/`）：
 *   档1｜同一项目名再导（带 `--force` 也一样）⇒ 被「项目已存在」闸拦下，`assets/` 计数 **N → N**；
 *   档2｜同一来源换**新项目**：不带 `--force` 被**来源指纹**闸拒（零复制、连目录都没建）｜
 *        带 `--force` ⇒ 新项目里**又各复制一份**（全库 **N → 2N**）；
 *   档3｜「往已有项目再导一次」这一档在 `import-project` 上**不可达** —— 它只有"从零建项目"这一形态：
 *        项目名重复一律**先**被名字闸拦下（连**换一份来源文件**、带 `--force` 都不行）
 *        ⇒ `N → N+1` 的真路径仍只在 `import-md --force`（E-② 档3，本文件 G 组旁边那条路）。
 * 与 E 组的关系（**同形 / 新型**，这是本组要回答的问题）：档1、档2 **同形**（连闸门都共用同一套
 *   字面量：名字闸那句与 `import-dir` 逐字相同、`--force` 的分工也相同）；档3 是**新型**：
 *   E 组档3 有一条真路径（`import-md --force`），而 `import-project` 上是"这一档不存在"。
 * 判别力（逐档点名：哪一行坏了会让哪一条红）：
 *   · 档1 ← `cli/commands/project.js:475` 的「项目已存在」闸（`--force` 不参与那一句的判断）；
 *   · 档2 ← 同文件 `:500` 的 `const refused = !!dup && !ctx.args.force;`（去掉 `!ctx.args.force`
 *     ⇒ 第二次仍 exit 1 ⇒ 档2 红）；反向：`resolveImportRefs` 若开始**跨项目复用**已有资源
 *     ⇒ 新项目的 `assets/` 会是 0 ⇒ 档2 也红；
 *   · 档3 ← `:475`（名字闸）与 `:496-500`（来源闸）的**先后顺序**：把名字闸挪到来源闸之后、
 *     或给已存在项目加一条"追加"分支 ⇒ 档3 红（它同时用**用法行**把"没有追加开关"钉住）。
 * ========================================================================== */
describe('【批8】J. `import-project` 的同款边界三档（对照 E 组：同形 / 新型）', () => {
  it('档1｜同一项目名再导（带 `--force` 也一样）⇒ 被「项目已存在」闸拦下，assets/ 计数 N → N', () => {
    const dir = mkSource('j1');
    fs.writeFileSync(path.join(dir, 'assets', 'x.png'), pngBytes('j1'));
    const md = writeMd(dir, 'doc.md', ['# 第一章', '', '![图](assets/x.png)', '', '正文', '']);
    const P = 'b8-j1';
    expect(run(['import-project', P, md]).code).toBe(0);
    const a1 = listDir(path.join(projDir(P), 'assets'));
    expect(a1, '第一档起点：N=1').toHaveLength(1);
    const again = run(['import-project', P, md, '--force']);
    expect(again.code, '同一项目名再导 ⇒ 名字闸拦下（`--force` 不给它开口）').toBe(1);
    expect(again.stdout).toContain('项目已存在');
    const a2 = listDir(path.join(projDir(P), 'assets'));
    expect(a2, 'assets/ 计数 N → N：一个字节都没多复制').toEqual(a1);
    console.log('[批8 实测·J 档1] import-project 同项目名（--force）：exit=' + again.code
      + ' ｜ assets ' + a1.length + '→' + a2.length + ' ｜ 与 E 档1 **同形**');
  });

  it('档2｜同一来源换新项目：不带 `--force` 被来源指纹闸拒（零复制）｜带 `--force` ⇒ 新项目里又各复制一份', () => {
    const dir = mkSource('j2');
    fs.writeFileSync(path.join(dir, 'assets', 'x.png'), pngBytes('j2'));
    const md = writeMd(dir, 'doc.md', ['# 第一章', '', '![图](assets/x.png)', '', '正文', '']);
    const A = 'b8-j2-a';
    const B = 'b8-j2-b';
    const C = 'b8-j2-c';
    expect(run(['import-project', A, md]).code).toBe(0);
    const a1 = listDir(path.join(projDir(A), 'assets'));
    expect(a1).toHaveLength(1);

    const noForce = run(['import-project', B, md]);
    expect(noForce.code, '不带 `--force`：同一来源跨项目也被拒（来源指纹闸）').toBe(1);
    expect(noForce.stdout).toMatch(/已经导入过/);
    expect(fs.existsSync(projFile(B)), '被拒时项目文件一个字都没写').toBe(false);
    expect(listDir(path.join(projDir(B), 'assets')), '被拒时一个资源都没复制（连目录都没建）').toBe(null);

    const forced = run(['import-project', C, md, '--force']);
    expect(forced.code, forced.stdout).toBe(0);
    const c1 = listDir(path.join(projDir(C), 'assets'));
    expect(c1, '新项目里**又各复制一份**（与第一档同量级 N）').toHaveLength(a1.length);
    expect(c1, '靠**新名字**区分 ⇒ 不是复用第一份、也没有跨项目按内容去重').not.toEqual(a1);
    expect(fs.readFileSync(path.join(projDir(C), 'assets', c1[0])), '第二份也是逐字节真复制').toEqual(pngBytes('j2'));
    expect(listDir(path.join(projDir(A), 'assets')), '第一份一字不动').toEqual(a1);
    expect(refsOf(A).map((x) => x.file)[0]).toMatch(/^assets\//);
    expect(refsOf(C).map((x) => x.file)[0]).toMatch(/^assets\//);
    expect(danglingOf(A)).toEqual([]);
    expect(danglingOf(C)).toEqual([]);
    console.log('[批8 实测·J 档2] import-project 换新项目（--force）：' + a1.length + '→' + c1.length
      + ' ｜ 两个项目各自一份 ⇒ 全库 2N（不是 N+1）｜ 与 E 档2 **同形**');
  });

  it('档3（**新型**）｜「往已有项目追加」在 `import-project` 上不可达：换一份来源文件 + `--force` 也进不去', () => {
    const dir = mkSource('j3');
    fs.writeFileSync(path.join(dir, 'assets', 'x.png'), pngBytes('j3'));
    const md1 = writeMd(dir, 'one.md', ['# 第一章', '', '![图](assets/x.png)', '']);
    const md2 = writeMd(dir, 'two.md', ['# 另一章', '', '![图](assets/x.png)', '']);
    const P = 'b8-j3';
    expect(run(['import-project', P, md1]).code).toBe(0);
    const beforeJson = fs.readFileSync(projFile(P));
    const beforeAssets = listDir(path.join(projDir(P), 'assets'));

    // 换一份**来源不同**的文件（不同 src + 不同 sha256 ⇒ 来源指纹闸根本不会触发）
    const other = run(['import-project', P, md2, '--force']);
    expect(other.code, '名字闸在来源闸**之前**：换了来源文件也进不去').toBe(1);
    expect(other.stdout).toContain('项目已存在');
    expect(fs.readFileSync(projFile(P)), '被拒时项目数据逐字节不变').toEqual(beforeJson);
    expect(listDir(path.join(projDir(P), 'assets')), '被拒时一个资源都没多').toEqual(beforeAssets);

    // 命令面：只有"新项目名 + 文件"这一种形态（没有 `--parent` 那类"往已有项目里挂"的开关）
    const usage = run(['import-project', 'b8-j3-usage']);
    expect(usage.code).toBe(1);
    expect(usage.stdout, '用法里点名"新项目名"').toContain('新项目名');
    expect(usage.stdout, '没有追加形态的开关（`import-md` 的 `--parent` 不在这一条命令上）').not.toContain('--parent');
    console.log('[批8 实测·J 档3] import-project 往已有项目再导：exit=' + other.code
      + '（换来源 + --force 也一样）⇒ 本命令**没有"追加"这一档**；N → N+1 仍只在 import-md --force（E 档3）');
  });
});

/* ============================================================================
 * 【批9】资源新名字的**唯一性闸**：同一毫秒的两条引用不许互相覆盖（产品侧已修）
 * ==========================================================================
 * 缺陷（批8 实测登记，原文见 `tests/import-dir-refs.test.js` 的【批8】注；本批在**产品侧**修掉）：
 *   `src/markdown.js` 的复制那一跳原来是
 *     const dest = path.join(dirFn(), newResourceName(ext));
 *     fs.mkdirSync(path.dirname(dest), { recursive: true });
 *     fs.copyFileSync(r.srcPath, dest);
 *   目标名**不做唯一性检查**；新名 = `Date.now().toString(36)` + **4 位随机** + 扩展名 ⇒ 同一份 md
 *   里的两条引用**必然同一毫秒**被复制（相邻两次 `copyFileSync`，中间没有别的同步点）⇒ 只剩 4 位随机
 *   在区分，撞上（1/36⁴ ≈ 1/1.68M）时第二次复制**覆盖**第一次 ⇒ 两个**不同**源文件**静默丢一份**
 *   （真·数据丢失：盘上看不出异常，两条引用还都指得着一份文件）。
 * 修法：目标名加唯一性闸 —— **照本工程既有先例** `src/doc-import.js` 的 `uniqueIdGen()`（"见过就
 *   再摇一次"），并带**重摇上界**（撞不出新名字时响亮报错，而不是死循环）。三条口径：
 *   ① **正常路径（不撞名）逐字节不变** —— 返回值就是 `path.join(dir, newResourceName(ext))` 那一个值，
 *      命名形状一个字没动（T2 就是钉这一条的判据）；
 *   ② 撞名时**只换名字**，内容仍是那份源文件（T1）；
 *   ③ **绝不覆盖**已存在的文件；名字摇不动就报错（T3）。
 * 四条判据的**判别力**（逐条点名"哪一行坏了会让哪一条红"）：
 *   · T1 ← 把产品侧那道闸去掉（`uniqueResourcePath` 换回裸 `path.join(dir, newResourceName(ext))`）
 *     ⇒ 第二次 `copyFileSync` 覆盖第一次 ⇒ 盘上 1 份、两条引用同名 ⇒ 三处断言同时红；
 *   · T2 ← 为"防撞"顺手改掉命名形状（换 uuid / 加计数器后缀 / 把 4 位随机加长）⇒
 *     "名字逐字节等于 `Date.now().toString(36)` + 4 位随机 + 扩展名"那条必红（**既有形状不许被修法改掉**）；
 *   · T3 ← 把重摇上界去掉、或让撞名改成"覆盖"⇒ 本用例要么**挂死**、要么"响亮报错"那条红
 *     （`Math.random` 打桩里带一条**摇名预算**，所以"死循环"会变成一条**可读的红**，不是超时）；
 *   · T4 ← 端到端接线：`import-md` 走的就是同一条路（`cli/commands/project.js:849`）—— 这条的"撞不撞名"
 *     由真随机决定 ⇒ 它只是**接线 + 同毫秒前置条件**的证据，**确定性的判别力在 T1**（这一条如实登记，不夸大）。
 * ⚠️ 注入缝隙只有**全局**的 `Date.now` / `Math.random`（`newResourceName` 在模块闭包里，外部改不到它），
 *   所以每个用例都在 `finally` 里逐字还原，且**只把被钉住的那一小段**交给被测代码。
 * ========================================================================== */

/** 钉住两个"随机源"，把"同一毫秒 + 同 4 位随机"变成一个**确定性**事件（不再靠概率撞）。
 *  @param {number} ms `Date.now()` 的钉死值（= 两条引用共用同一个毫秒）
 *  @param {number|number[]} rand 数字 ⇒ 钉成常量（永远摇出同一个名字）；数组 ⇒ 按队列给值、
 *         用完**交回真随机** —— 交回真随机正是"重摇能摇出别的名字"的那一半
 *  @param {number} [budget] 本用例允许的**摇名次数上界**：超了就在 `Math.random` 里抛错
 *         ⇒ "重摇上界被删掉"的注入不会把用例挂死，而是变成一条可读的红
 *  @returns {{draws:()=>number, restore:()=>void}} */
function pinNaming(ms, rand, budget) {
  const realNow = Date.now;
  const realRandom = Math.random;
  const q = Array.isArray(rand) ? rand.slice() : null;
  const fixed = q ? null : rand;
  const limit = budget || 4096;
  let draws = 0;
  Date.now = () => ms;
  Math.random = () => {
    draws++;
    if (draws > limit) {
      throw new Error('摇名次数超过本用例的预算 ' + limit + ' ⇒ 撞名之后没能"再摇一次"'
        + '（上界被删掉，或撞名被改成了覆盖）：这条不是超时，是判据');
    }
    return q ? (q.length ? q.shift() : realRandom()) : fixed;
  };
  return { draws: () => draws, restore: () => { Date.now = realNow; Math.random = realRandom; } };
}

/** 单元级：直接调 `resolveImportRefs`（与三条导入命令同**一个**函数、同一条 copy 分支）。
 *  为什么单元级也要有：这一次调用里 `Math.random` 的消耗是**可数**的（只有摇名在用它）
 *  ⇒ "撞名"能被钉成确定事件，而不是等 1/1.68M 的概率。 */
function unitImport(node, srcDir, destDir) {
  return markdown.resolveImportRefs(node, {
    baseDir: srcDir,
    projectDir: destDir,
    assetDir: () => path.join(destDir, 'assets'),
    attachmentDir: () => path.join(destDir, 'attachments')
  });
}

describe('【批9】资源新名字的唯一性闸（同一毫秒的两条引用不许互相覆盖）', () => {
  const MS = 1730000000000;                 // 固定的毫秒值：两条引用"同一毫秒"的那个分母
  const SAME = 0.5;                         // `(0.5).toString(36).slice(2, 6)` = 'i' ⇒ 两次摇名给出同一个名字

  it('T1 同一毫秒 + 同 4 位随机（钉成常量）⇒ 两个**不同**源文件都落地、字节各对各、名字不同', () => {
    const dir = mkSource('b9-t1');
    fs.writeFileSync(path.join(dir, 'assets', 'jia.png'), pngBytes('甲'));
    fs.writeFileSync(path.join(dir, 'assets', 'yi.png'), pngBytes('乙'));
    const dest = fs.mkdtempSync(path.join(WORK, 'b9-t1-dest-'));
    const node = { id: 'n-t1', topic: '双图章', children: [], images: [
      { file: 'assets/jia.png', caption: '甲' }, { file: 'assets/yi.png', caption: '乙' }] };
    const pin = pinNaming(MS, [SAME, SAME]);   // 前两次摇名 = 同一个名字（撞名）；之后交回真随机（重摇）
    let rep = null;
    try { rep = unitImport(node, dir, dest); } finally { pin.restore(); }

    expect(rep.ok, '两条引用都解析得到 ⇒ 不该是"拒绝"').toBe(true);
    expect(rep.copied, '两条引用 = **两次**复制（没有被去重成 1）').toHaveLength(2);
    const files = listDir(path.join(dest, 'assets')) || [];
    expect(files, '两个**不同**源文件 ⇒ 盘上必须**两份**（修前：只剩 1 份，另一份被静默覆盖）')
      .toHaveLength(2);
    const refs = node.images.map((i) => i.file);
    expect(refs.length, '两条引用都挂在 images[] 上').toBe(2);
    expect(new Set(refs).size, '两条引用必须指向**不同**的名字').toBe(2);
    node.images.forEach((img, i) => {
      expect(fs.readFileSync(path.join(dest, img.file)), '第 ' + (i + 1) + ' 条引用指到的文件 = **它自己的**源文件')
        .toEqual(pngBytes(['甲', '乙'][i]));
    });
    expect(pin.draws(), '撞名 ⇒ 多摇了一次（不是"去重"也不是"覆盖"）').toBe(3);
    console.log('[批9 实测·T1] 摇名次数=' + pin.draws() + '（1 正常 + 1 撞名 + 1 重摇）'
      + ' ｜ 落地=' + JSON.stringify(files) + ' ｜ images=' + JSON.stringify(refs)
      + ' ｜ 重摇出的名字 ' + refs[1] + ' ≠ 若不去重/不重摇本会得到的名字 ' + refs[0]);
  });

  it('T2 口径：**不撞名**时命名与从前**逐字节相同**（形状一个字没动、也不多摇）', () => {
    const dir = mkSource('b9-t2');
    fs.writeFileSync(path.join(dir, 'assets', 'a.png'), pngBytes('正常'));
    fs.writeFileSync(path.join(dir, 'attachments', 'no-ext'), textBytes('附件无扩展名'));
    const dest = fs.mkdtempSync(path.join(WORK, 'b9-t2-dest-'));
    const node = { id: 'n-t2', topic: '正常章', children: [],
      images: [{ file: 'assets/a.png', caption: '正常' }],
      files: [{ file: 'attachments/no-ext', caption: '附件' }] };
    // 图片进 assets/、附件进 attachments/：**两个不同目录** ⇒ 同一个名字也不构成撞名（正常路径）
    const pin = pinNaming(MS, SAME);
    let rep = null;
    try { rep = unitImport(node, dir, dest); } finally { pin.restore(); }

    expect(rep.ok).toBe(true);
    const base = MS.toString(36) + (SAME).toString(36).slice(2, 6);   // 与产品**同一个表达式**，不另抄一份形状
    expect(node.images[0].file, '图片名 = `Date.now()` 的 36 进制 + 4 位随机 + 扩展名（与修前逐字节相同）')
      .toBe('assets/' + base + '.png');
    expect(node.files[0].file, '附件的扩展名兜底仍是 .bin（同 assets.js 的 copyAttachment）')
      .toBe('attachments/' + base + '.bin');
    expect(listDir(path.join(dest, 'assets')), '盘上就是这个名字（没有括号/计数器之类的新形状）')
      .toEqual([base + '.png']);
    expect(listDir(path.join(dest, 'attachments'))).toEqual([base + '.bin']);
    expect(pin.draws(), '不撞名 ⇒ 每条引用**只摇一次**：唯一性闸在正常路径上不多摇').toBe(2);
    expect(fs.readFileSync(path.join(dest, node.images[0].file))).toEqual(pngBytes('正常'));
    expect(fs.readFileSync(path.join(dest, node.files[0].file))).toEqual(textBytes('附件无扩展名'));
    console.log('[批9 实测·T2] 不撞名时的名字=' + node.images[0].file + ' / ' + node.files[0].file
      + '（= `Date.now()` 的 36 进制 + 4 位随机 + 扩展名）｜ 摇名次数=' + pin.draws());
  });

  it('T3 撞名**绝不覆盖**：目标名已被占、名字又摇不动 ⇒ 响亮报错（不死循环），被占的文件一字不改', () => {
    const dir = mkSource('b9-t3');
    fs.writeFileSync(path.join(dir, 'assets', 'a.png'), pngBytes('源'));
    const dest = fs.mkdtempSync(path.join(WORK, 'b9-t3-dest-'));
    const assets = path.join(dest, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    const taken = MS.toString(36) + (SAME).toString(36).slice(2, 6) + '.png';    // 钉死的那一个名字
    fs.writeFileSync(path.join(assets, taken), pngBytes('占位'));
    const node = { id: 'n-t3', topic: '占位章', children: [], images: [{ file: 'assets/a.png', caption: '源' }] };
    const pin = pinNaming(MS, SAME, 64);       // 名字**永远**是同一个 ⇒ 重摇也撞（预算 64 防"挂死"）
    let err = null;
    try { unitImport(node, dir, dest); } catch (e) { err = e; } finally { pin.restore(); }

    expect(err, '撞名且摇不出新名字 ⇒ 必须**响亮报错**（不许死循环、更不许覆盖）').toBeTruthy();
    expect(err.message, '报错要指得出"撞上盘上已存在的文件"').toContain('撞上盘上已存在的文件');
    expect(err.message, '报错要指回唯一的修法现场').toContain('newResourceName');
    expect(fs.readFileSync(path.join(assets, taken)), '被占的那个文件**一个字节都没改**').toEqual(pngBytes('占位'));
    expect(listDir(assets), '没有多出第二个文件、也没留下临时物').toEqual([taken]);
    expect(pin.draws(), '重摇有上界（8 次）⇒ 摇名次数有限，报错**及时**').toBeLessThanOrEqual(16);
    console.log('[批9 实测·T3] ' + err.message + ' ｜ 摇名次数=' + pin.draws() + '（上界=8 ⇒ 不是死循环）');
  });

  it('T4 端到端接线：`import-md` 在"同一毫秒"条件下两条引用各落一份、字节都对、名字不同', () => {
    const dir = mkSource('b9-t4');
    fs.writeFileSync(path.join(dir, 'assets', 'jia.png'), pngBytes('甲'));
    fs.writeFileSync(path.join(dir, 'assets', 'yi.png'), pngBytes('乙'));
    const md = writeMd(dir, 'two.md', ['# 双图章', '', '![图：甲](assets/jia.png)', '',
      '![图：乙](assets/yi.png)', '']);
    const P = 'b9-t4';
    expect(run(['init', P]).code).toBe(0);
    const pin = pinNaming(MS, []);             // 只钉毫秒（两条引用必然同一毫秒）；随机仍是**真随机**
    let r = null;
    try { r = run(['import-md', P, md, '--parent', 'root']); } finally { pin.restore(); }

    expect(r.code, r.stdout).toBe(0);
    assertRefsLanded(P, { assets: 2, attachments: 0 });
    const refs = refsOf(P).filter((x) => x.kind === 'image').map((x) => x.file);
    expect(new Set(refs).size, '两条引用指向**不同**路径').toBe(2);
    refs.forEach((f) => expect(f.startsWith('assets/' + MS.toString(36)),
      '毫秒部分 = **被钉死的那个值** ⇒ 这两条引用确实是"同一毫秒"（本用例的前置条件成立）').toBe(true));
    const got = refs.map((f) => fs.readFileSync(path.join(projDir(P), f)).toString('base64')).sort();
    expect(got, '两个源文件的内容都在（**丢一份**在这里就会红 —— 那正是这条修的东西）')
      .toEqual([pngBytes('甲').toString('base64'), pngBytes('乙').toString('base64')].sort());
    console.log('[批9 实测·T4] import-md 同一毫秒两条引用：images=' + JSON.stringify(refs)
      + ' ｜ assets=' + JSON.stringify(listDir(path.join(projDir(P), 'assets'))));
  });
});
