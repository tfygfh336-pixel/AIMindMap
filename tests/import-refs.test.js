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
 *   D. 与 `add-image` **同一条规则**：图片扩展名白名单、命名表达式。命名规则现在是**一处实现**
 *      （`src/markdown.js`，【批10】起 `assets.js` 调它而不是各写一份）⇒ 断言从"两处同形"换成
 *      "**全树可执行代码里只有一处**" + "assets.js 两条复制路都按属性调它、且不是解构"
 *      （`tests/cli-sync-invariant.test.js` 的写法：先剥注释再比对，别拿散文当判据）。
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
 *   L.【批10】同一条闸补到 `add-image` / `add-file` 那条路（`cli/commands/assets.js` 的
 *      copyAsset / copyAttachment，【批9】如实登记的那个同类缺口）：命名与唯一性**只有一处实现**
 *      （`src/markdown.js`，`cli`→`src` 方向合法、无环）—— 判据 T1/T2/T6/T7/T8/T9/T10 与逐条判别力
 *      见文件末尾的【批10】组注。
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
  /** 表达式本体；**全树只许出现在 `src/markdown.js`**。别处那些 `'n' + Date.now()…` /
   *  `'a-' + …` / `'i-' + …` / `base + '-' + …` 是**节点 id** 的生成式（另一条规则），不该被这条
   *  断言牵连 —— 所以下面钉的是"**整条语句**"的形态：表达式 + 结尾分号。
   *  为什么这个形状刚好分得开（实读，不是推理）：资源名那一处是 `return <表达式> + ext;`，
   *  而 id 那几处全都是 `return 'n-' + <表达式>;` 之类的**前缀拼接** ⇒ 表达式的右邻是 `;` 的
   *  只有资源命名这一处（`newResourceName` 的第 2 行）。谁把表达式原样抄回 assets.js 当独立
   *  语句用，这条立刻红 —— 而那正是"复制回一份"的最短路径。
   *  ⚠️ 本测试文件里也出现这个字符串（这一行、以及 T2 那句"漂移就改这里"的注释）—— 那两处是
   *  **回归声明**，不是第二份实现；因此下面的断言必须先**剥注释**再比对（`stripComments`），
   *  否则注释里的字符串会让"assets.js 里不许有"这条自己变红。 */
  const NAME_EXPR = 'Date.now().toString(36) + Math.random().toString(36).slice(2, 6)';
  /** "这条命名规则**独占**一次 return/赋值"的形状：左边不能再有 `'n-' + ` 之类的**前缀拼接**
   *  （那是 id 生成式 —— 另一条规则，`src/assoc.js` / `src/item-model.js` / `markdown.js:52` 的
   *  `idGen` / 冒烟脚本 / `renderer/app-actions.js` 都是那种形状，不该被这条断言牵连），
   *  右边必须是 `;` 或 `+ ext` 这样的收尾。
   *  实读（本批改动前的全树）：`(?<![\w'"`+\-])` 这个左边界还不够 —— `'a-' + Math…` 里 `+` 与
   *  表达式之间还有空格 ⇒ 仍会命中。所以这里改成**行首形态**：`^\s*return\s+<表达式>`。
   *  全树只有 `src/markdown.js` 的 `newResourceName` 是那一行（谁把命名规则抄回别处并写成
   *  `return …`，这条立刻红）。 */
  const NAME_STMT_ONLY = new RegExp('^\\s*return\\s+' + NAME_EXPR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s*[+;])', 'm');
  const EXT_RE_SRC = '/\\.(png|jpe?g|gif|webp|svg|bmp)$/';
  /** 剥掉块注释与整行行注释（同 `tests/cli-sync-invariant.test.js` 的手法）：
   *  断言要看的是**可执行的那一份**，不是散文里的字符串。刻意不解析字符串字面量（那要真语法
   *  分析）—— 代价见上面那条注释。 */
  const stripComments = (src) => String(src).replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line)).join('\n');
  /** 收集"这条命名规则写在哪些文件的**可执行代码**里"（剥注释后按"独占一次 return"的形状匹配）。
   *  刻意不扫 `tests/`：本文件自己要写"回归声明"，那是判据的对照物，不是第二份实现。 */
  const NAME_REFS = () => {
    const out = [];
    ['cli', 'src', path.join('scripts', 'smoke'), 'renderer'].forEach((sub) => {
      (listDir(path.join(REPO, sub)) || []).filter((f) => f.endsWith('.js')).forEach((f) => {
        if (NAME_STMT_ONLY.test(stripComments(fs.readFileSync(path.join(REPO, sub, f), 'utf8')))) {
          out.push(sub.replace(/\\/g, '/') + '/' + f);
        }
      });
    });
    return out;
  };

  it('命名表达式：`src/markdown.js` 里**逐字**还在（唯一一份可执行实现），别处一处都没有', () => {
    expect(stripComments(mdSrc), '命名规则只剩这一份了 —— 它必须一字不动地在这儿').toContain(NAME_EXPR);
    expect(stripComments(assetsSrc), '命名表达式不许再回到 assets.js（那正是第二份实现）').not.toContain(NAME_EXPR);
    expect(NAME_REFS(), '全树可执行代码里，这条命名规则只许出现在 src/markdown.js（实读：只有那一处）')
      .toEqual([path.join('src', 'markdown.js').replace(/\\/g, '/')]);
  });

  it('assets.js 走的就是那一份（属性调用，不是解构 —— 解构会把"同一个函数"这条判据变成空话）', () => {
    const code = stripComments(assetsSrc);
    expect(code, 'copyAsset 的目录 + 唯一性闸 = 调 src/markdown.js 的 uniqueResourcePath')
      .toContain('markdown.uniqueResourcePath(');
    const gateCalls = code.match(/markdown\.uniqueResourcePath\(/g) || [];
    expect(gateCalls.length, 'copyAsset / copyAttachment **两条**路都得走这道闸'
      + '（只补一条 ⇒ 另一条仍是覆盖；运行时判据见【批10】T1 与 T10）').toBe(2);
    expect(code).not.toMatch(/(const|let|var)\s*\{[^}]*\b(newResourceName|uniqueResourcePath)\b/);
    /* 导出面自证：漏导出时 `require` 的模块属性是 `undefined`，`node --check` 照样绿；
     * 值断言 = 编译期那一半，真调用的那一半在下面【批10】的 T7（单源等价）/ T8（真调到这一处）。 */
    expect(markdown.newResourceName, 'src/markdown.js 必须导出 newResourceName').toBeTypeOf('function');
    expect(markdown.uniqueResourcePath, 'src/markdown.js 必须导出 uniqueResourcePath').toBeTypeOf('function');
    expect(markdown.newResourceName('.png'), '真调用一次（形状的权威读数在 T2）').toMatch(/^[0-9a-z]{5,}\.png$/);
    expect(markdown.RESOURCE_NAME_MAX_TRIES, '重摇上界的值就是注释里写的那个 8（T3/T9 的哨兵）').toBe(8);
    expect(Number.isInteger(markdown.RESOURCE_NAME_MAX_TRIES)).toBe(true);
    expect(markdown.RESOURCE_NAME_MAX_TRIES, '上界必须 ≥1：0 次重摇 = 撞名即报错，"只换名字"这条口径就没了')
      .toBeGreaterThanOrEqual(1);
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
 *  @param {number[]} [eco] **队列用完之后的"重摇源"**：给了它，重摇就摇出这些**写死的**值
 *         （确定性），而不是交回真随机。为什么要这个口子（【批10】实测教训，如实登记）：
 *         队列用完交回真随机时，重摇**仍有** 1/36⁴ 的概率摇回正被占用的那个名字 ——
 *         那时用例会以"名字又撞上"而不是"改名生效"为由变红。概率极小，但**判据不该是概率**：
 *         `tests/import-dir-refs.test.js` 的【批8】整段就是在讲"概率型假红"的代价。
 *         本参数只给【批10】的撞名用例用；【批9】的 T1/T3 保持原样（它们靠的是"交回真随机"）。
 *  @returns {{draws:()=>number, restore:()=>void}} */
function pinNaming(ms, rand, budget, eco) {
  const realNow = Date.now;
  const realRandom = Math.random;
  const q = Array.isArray(rand) ? rand.slice() : null;
  const fixed = q ? null : rand;
  const limit = budget || 4096;
  const ecoQ = (eco || []).slice();
  let draws = 0;
  Date.now = () => ms;
  Math.random = () => {
    draws++;
    if (draws > limit) {
      throw new Error('摇名次数超过本用例的预算 ' + limit + ' ⇒ 撞名之后没能"再摇一次"'
        + '（上界被删掉，或撞名被改成了覆盖）：这条不是超时，是判据');
    }
    if (q === null) return fixed;
    if (q.length) return q.shift();
    if (ecoQ.length) return ecoQ.shift();
    return realRandom();
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

/* ============================================================================
 * 【批10】`add-image` / `add-file` 那条路（`cli/commands/assets.js` 的 copyAsset / copyAttachment）
 *          补上同一道唯一性闸 —— 【批9】登记的那个"最后一个同类缺口"
 * ==========================================================================
 * 【批9】把 `src/markdown.js` 的复制那一跳修掉了（`uniqueResourcePath`），但**如实登记**：
 *   `cli/commands/assets.js` 的 copyAsset / copyAttachment 仍是裸
 *     const base = Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + ext;
 *     fs.copyFileSync(srcPath, path.join(dir, base));
 *   —— 目标名不查重名 ⇒ 两个不同源文件抢到同一个名字时，第二个 `copyFileSync` **静默覆盖**第一个。
 *   走 `add-image` / `add-file` 的**任何**路径（CLI、MCP、侧栏、界面代写）都属于这一档。
 * 本批修法（**优先复用，不重写**）：命名与唯一性**全工程只有一处实现**，在 `src/markdown.js`；
 *   `assets.js` 改成 `require('../../src/markdown.js')` 并**在调用点按属性取值**调
 *   `markdown.uniqueResourcePath(dir, ext)`。为什么复用而不是"照抄一份带闸的"：
 *   · 命名形状（时间36进制 + 4 位随机 + 扩展名）本来就是**一条规则**，工程规矩是"一份事实一处实现"；
 *   · 两份实现的真实代价已经在【批9】付过一次：那一批只给 `src/` 那份加了闸，`cli/` 这份就漏了 ——
 *     这次的复用在**结构上**让"两处漂移"不可表达（不是再加一条同形断言去盯人）；
 *   · 依赖方向合法：`cli/`(rank 2) → `src/`(rank 1) 朝下，实跑 `node scripts/dep-direction-check.js`
 *     135 条相对边全部朝下、无环、无图外边（134 → 135：新增的就是 `assets.js` 这条 require）。
 * 三条口径与【批9】逐字相同：
 *   ① **正常路径逐字节不变**：不撞名时拿到就是原来那一个名字（T2 钉这一条）；
 *   ② 撞名**只换名字**：内容仍是那条记录自己的源文件（T1/T6 —— T6 就是本次要证的"毫秒撞名"）；
 *   ③ **绝不覆盖**：已存在的文件一个字节都不改；连撞到上界（8）**响亮报错**且给出路（T9）。
 * 判据的**判别力**（逐条点名"哪一行坏了会让哪一条红"）：
 *   · T1/T6 ← 把 `assets.js` 的唯一性闸去掉（`markdown.uniqueResourcePath(dir, ext)` 换回裸
 *     `const base = Date.now().toString(36) + Math.random()… + ext; fs.copyFileSync(src, path.join(dir, base))`）
 *     ⇒ 第二个 `copyFileSync` 覆盖第一个 ⇒ T1 的"两条引用名字不同"、T6 的"两个名字/两份内容"同时红
 *     （**修前必红**的取证就是这一条；本批实跑：注入 A ⇒ 6 红，含 T1/T6/T9 + D 组两条静态断言）；
 *   · T2 ← 为"防撞"顺手改掉命名形状（换 uuid / 加计数器 / 把 4 位随机加长）⇒ "名字逐字节等于
 *     `Date.now().toString(36)` + 4 位随机 + 扩展名"那条必红（既有形状不许被修法改掉）；
 *   · T9 ← 把重摇上界去掉（或把撞名改成覆盖）⇒ 要么挂死、要么"响亮报错 + 出路"那条红
 *     （`pinNaming` 带**摇名预算**，所以"死循环"会变成一条可读的红，不是超时）；
 *   · T7/T8 ← 谁把命名规则复制回 `assets.js` 一份 ⇒ 同一个注入条件下两条路摇出的名字不再逐字节相同
 *     （T7），且"`assets.js` 两条路交给那一处、用它的返回值落盘"的命中数变 1（只够 `add-image`）或 0
 *     （T8）—— **这就是"不是第二份实现"的判据**，不靠"读一眼代码觉得像"；
 *   · T11 ← **去掉闸**（把 `markdown.uniqueResourcePath` 换成修前那两行：摇名 + 直接 copy，不查重名）
 *     ⇒ 两条命令 exit 0、两条引用**同名**、盘上只剩 1 份、甲的内容静默消失 —— 这一条的实测读数就是
 *     T1 那批断言会红的那个状态（确定性复现，不靠概率）。
 * ⚠️ **T11 为什么在进程内注入、而不去改产品文件**（本会话实读的教训，如实登记）：改文件那种注入要在
 *   跑测试的中途写盘，一旦"恢复"那一步出岔子就留下**一半注入的源码**。本会话真出过一次：注入脚本的
 *   还原被 UTF-8 BOM 污染，`assets.js` 一半是闸、一半是旧行为，随后**全量跑出来的 4 条红全是假红**
 *   （文件哈希在前/后都对不上真实内容，差点把假红当成回归记录）。结论：**注入证明的成本不该由产品
 *   代码承担** —— `assets.js` 走的是模块属性调用，在测试里换掉那个导出项就能精确复现"闸不存在"，
 *   而且 revert 由 `finally` 保证（跑完还可能断言"已还原"）。
 * ⚠️ 注入缝隙与【批9】同一条：只有**全局** `Date.now` / `Math.random`（`newResourceName` 在模块闭包里，
 *   外部改不到它），所以每个用例都在 `finally` 里逐字还原。
 * ⚠️ **如实登记的边界（T8 的适用范围）**：`src/markdown.js` 内部（`resolveImportRefs` → `uniqueResourcePath`）
 *   用的是**闭包引用**，替换模块导出项**拦不住**它（实读：换掉导出项后 `import-md` 命中 0 次，
 *   而 `add-image` / `add-file` 各命中 1 次 —— 因为 `assets.js` 是模块属性调用）。所以 T8 只证
 *   "`cli/` 那条路真走到了那一处、并用它的返回值落盘"；"`src/` 那条路没有第二份实现"由 D 组
 *   那条**全树唯一**的静态断言覆盖（剥注释后按"独占一次 return"的形状匹配，实读只命中
 *   `src/markdown.js`）。把这条边界写在这里，是为了不让"T8 绿了"被读成"两条路都被注入验过了"。
 * ⚠️ 为什么这两条路都走 `invokeSync` 端到端：`copyAsset` / `copyAttachment` 是模块内部函数，
 *   走命令还能顺带把"物理落盘在 mutate 之外、重放不多复制一份"这条不变量一起钉住（T6 的摇名次数=3）。
 * ⚠️ **本批自己踩到并修掉的一条"概率型假红"（如实登记）**：T1/T6 最初把"重摇"交给**真随机**
 *   （`pinNaming` 的队列用完 ⇒ `realRandom()`），于是重摇仍有 1/36⁴ 的概率摇回正被占用的那个名字
 *   ⇒ 用例以"名字又撞上"为由偶发变红（本会话实测撞到过一次：T1 红，`assets/…` 只剩两份名字）。
 *   处置：给 `pinNaming` 加第 4 个参数 `eco`（队列用完之后用**写死的**值继续供随机），T1/T6 用它把
 *   "重摇出什么名字"也钉死 ⇒ 判据重新变成确定性的（连跑 6 遍 + 全量一遍均绿）。
 *   为什么不能改成"放宽断言"（比如只数"名字不重复"）：那正是【批8】用户明确否掉的那条 ✗。
 * ========================================================================== */

describe('【批10】add-image / add-file 那条路补上同一道唯一性闸（复用 src/markdown.js 的唯一一处实现）', () => {
  const MS = 1730000000000;                 // 与【批9】同一份钉死值：所有"同一毫秒"用例共用
  const SAME = 0.5;                         // `(0.5).toString(36).slice(2, 6)` = 'i' ⇒ 每次摇名都给出同一个名字
  const PINNED = MS.toString(36) + (SAME).toString(36).slice(2, 6);       // 钉死条件下会摇出的那个名字

  /** 把"钉死名字"那一份先占在盘上：于是被测代码**第一次**摇名就撞上它 —— 不再靠 1/36⁴ 的概率。
   *  `bytes` 必须显式给：占位物的字节要与"应该一字不改"的那条断言*同源*（图片是 PNG 魔数、
   *  附件是正文），不能默认成图片 —— 否则验的是"占位物长得像不像图片"，不是"有没有被改"。 */
  function seedTaken(dir, name, bytes) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), bytes);
    return path.join(dir, name);
  }

  it('T1 撞名（目标名已被占、两个**不同**源文件同毫秒）⇒ 两份都在、字节各对各、名字不同、被占的那份一字不改', () => {
    expect(run(['init', 'b10-t1']).code).toBe(0);
    const dir = mkSource('b10-t1');
    fs.writeFileSync(path.join(dir, 'assets', 'jia.png'), pngBytes('甲'));
    fs.writeFileSync(path.join(dir, 'assets', 'yi.png'), pngBytes('乙'));
    const takenPath = seedTaken(path.join(projDir('b10-t1'), 'assets'), PINNED + '.png', pngBytes('占位'));
    /* ⚠️ 随机源**全确定性**：队列只给两次摇名（都被占位挡下），之后**两次重摇**由 `eco` 写死
     * （`0.125` / `0.03125` ⇒ 都是 `"4i"` 开头、互不相同）—— 这样两次 add-image 各自的重摇结果
     * 就不再靠真随机。为什么必须这么钉：若重摇交回**真随机**，就有 1/36⁴ 的概率又摇回 `i`
     * （正被占用的那个名字）⇒ 用例会以"名字又撞上"为由变红 —— 概率极小，但**判据不该是概率**
     * （同 `tests/import-dir-refs.test.js`【批8】整段讲的代价）。 */
    const pin = pinNaming(MS, [SAME, SAME], 0, [0.125, 0.03125]);
    let a = null; let b = null;
    try {
      a = run(['add-image', 'b10-t1', 'root', '--file', path.join(dir, 'assets', 'jia.png'), '--caption', '甲']);
      b = run(['add-image', 'b10-t1', 'root', '--file', path.join(dir, 'assets', 'yi.png'), '--caption', '乙']);
    } finally { pin.restore(); }

    expect(a.code, a.stdout).toBe(0);
    expect(b.code, b.stdout).toBe(0);
    const imgRefs = refsOf('b10-t1').filter((x) => x.kind === 'image').map((x) => x.file);
    expect(imgRefs, '两次 add-image = 两条引用').toHaveLength(2);
    expect(new Set(imgRefs).size, '两条引用必须指向**不同**的名字（撞名 ⇒ 重摇，不是复用同一个名字）').toBe(2);
    expect(imgRefs.slice().sort(), '两边都是"撞占位 ⇒ 重摇"，名字由 eco 写死（不再靠真随机帮忙）')
      .toEqual(['assets/' + MS.toString(36) + '14i.png', 'assets/' + MS.toString(36) + '4i.png']);
    ['甲', '乙'].forEach((tag, i) => {
      expect(fs.readFileSync(path.join(projDir('b10-t1'), imgRefs[i])), '第 ' + (i + 1) + ' 条引用 = **它自己的**源文件')
        .toEqual(pngBytes(tag));
    });
    /* ⚠️ 这两条是"修前必红"的形状：修前（assets.js 无闸）第二个 copyFileSync 会**直接覆盖**
     * `i.png` ⇒ 盘上只剩 2 份（占位 + 乙）、两条引用同名、甲的字节消失 ⇒ 下面两条断言同时红。 */
    expect(listDir(path.join(projDir('b10-t1'), 'assets')).length,
      '盘上 = 占位 1 + 两次 add-image 各 1 = 3 份（修前：后一次静默覆盖前一次 ⇒ 只剩 2 份）').toBe(3);
    expect(imgRefs.some((f) => f === 'assets/' + PINNED + '.png'),
      '两次摇名都被占位挡下 ⇒ 两条引用都不是那个被占的名字').toBe(false);
    expect(fs.readFileSync(takenPath), '被占的那份文件**一个字节都没改**（绝不覆盖）').toEqual(pngBytes('占位'));
    expect(pin.draws(), '撞名 ⇒ 多摇一次（不是去重、不是覆盖）：第 1 条 2 次 + 第 2 条 2 次 = 4 次摇名').toBe(4);
    console.log('[批10 实测·T1] 摇名次数=' + pin.draws() + '（被占的名字 ' + PINNED + '.png = ' + (SAME).toString(36).slice(2, 6)
      + '）｜ images=' + JSON.stringify(imgRefs) + ' ｜ assets=' + JSON.stringify(listDir(path.join(projDir('b10-t1'), 'assets'))));
  });

  it('T2 口径：**不撞名**时名字与旧表达式逐字节相同、每条只摇一次（唯一性闸在正常路径上不多摇）', () => {
    expect(run(['init', 'b10-t2']).code).toBe(0);
    const dir = mkSource('b10-t2');
    fs.writeFileSync(path.join(dir, 'assets', 'ok.png'), pngBytes('正常图片'));
    fs.writeFileSync(path.join(dir, 'attachments', 'no-ext'), textBytes('无扩展名附件'));
    const pin = pinNaming(MS, SAME);            // 常量：每次摇名都给出同一个名字（两条引用落在**两个不同目录** ⇒ 不构成撞名）
    let ai = null; let af = null;
    try {
      ai = run(['add-image', 'b10-t2', 'root', '--file', path.join(dir, 'assets', 'ok.png'), '--caption', '图']);
      af = run(['add-file', 'b10-t2', 'root', '--file', path.join(dir, 'attachments', 'no-ext'), '--caption', '附件']);
    } finally { pin.restore(); }

    expect(ai.code, ai.stdout).toBe(0);
    expect(af.code, af.stdout).toBe(0);
    /* 旧表达式在**本测试里**独立算一遍（这是"回归声明"，不是第二份实现 —— 产品侧只有一份，
     * 由上面 D 组那条"全树唯一"断言把守）。产品侧哪天改了形状（uuid / 计数器 / 加长随机），
     * 这里必红，而不是跟着一起漂。 */
    const oldShape = MS.toString(36) + (SAME).toString(36).slice(2, 6);
    expect(refsOf('b10-t2').map((x) => x.file).sort())
      .toEqual(['assets/' + oldShape + '.png', 'attachments/' + oldShape + '.bin']);
    expect(fs.readFileSync(path.join(projDir('b10-t2'), 'assets', oldShape + '.png')), '图片内容逐字节 = 源文件')
      .toEqual(pngBytes('正常图片'));
    expect(fs.readFileSync(path.join(projDir('b10-t2'), 'attachments', oldShape + '.bin')),
      '附件无扩展名仍兜底 .bin（与 copyAttachment 从前的行为逐字节相同）').toEqual(textBytes('无扩展名附件'));
    expect(pin.draws(), '不撞名 ⇒ 每条命令**只摇一次**（cp 之前/之后都没有多余的摇名）').toBe(2);
    console.log('[批10 实测·T2] 不撞名时的名字=assets/' + oldShape + '.png + attachments/' + oldShape + '.bin'
      + '（= `Date.now()` 的 36 进制 + 4 位随机 + 扩展名，与旧表达式逐字节相同）｜ 摇名次数=' + pin.draws());
  });

  it('T6 端到端：同一毫秒两次 add-image（撞名）⇒ 两份内容都在、两条引用不同（本次要证的"毫秒撞名"档）', () => {
    expect(run(['init', 'b10-t6']).code).toBe(0);
    const dir = mkSource('b10-t6');
    fs.writeFileSync(path.join(dir, 'assets', 'jia.png'), pngBytes('甲2'));
    fs.writeFileSync(path.join(dir, 'assets', 'yi.png'), pngBytes('乙2'));
    /* 随机源**全确定性**：第 1 次 add-image 拿队列第 1 个值 `i` 并落盘；第 2 次也拿 `i`（撞上刚落的
     * 那个文件、而且**没有占位物**）⇒ 重摇到队列第 2 个值 / eco 写死的 `4i`。这一条才是"同一毫秒两次
     * add-image"的**确定性**版本：交回真随机时会有 1/36⁴ 的概率摇回 `i` ⇒ 那条判据就成了概率，不该那么写。 */
    const pin = pinNaming(MS, [SAME, SAME, 0.125], 0, [0.03125]);
    let a = null; let b = null;
    try {
      a = run(['add-image', 'b10-t6', 'root', '--file', path.join(dir, 'assets', 'jia.png'), '--caption', '甲']);
      b = run(['add-image', 'b10-t6', 'root', '--file', path.join(dir, 'assets', 'yi.png'), '--caption', '乙']);
    } finally { pin.restore(); }

    expect(a.code, a.stdout).toBe(0);
    expect(b.code, b.stdout).toBe(0);
    const refs = refsOf('b10-t6').filter((x) => x.kind === 'image').map((x) => x.file);
    expect(new Set(refs).size, '两次同名 ⇒ 第二次必须重摇出另一个名字').toBe(2);
    expect(refs.slice().sort(), '第一个名字 = 钉死值；第二个 = 重摇出来的那一个（eco 写死）')
      .toEqual(['assets/' + MS.toString(36) + '4i.png', 'assets/' + MS.toString(36) + 'i.png']);
    expect(refs.every((f) => f.startsWith('assets/' + MS.toString(36))),
      '毫秒部分 = **被钉死的那个值** ⇒ 这两次确实是"同一毫秒"（本用例的前置条件成立）').toBe(true);
    const got = refs.map((f) => fs.readFileSync(path.join(projDir('b10-t6'), f)).toString('base64')).sort();
    expect(got, '两个源文件的内容都在（**丢一份**在这里就会红 —— 那正是本批修的东西）')
      .toEqual([pngBytes('甲2').toString('base64'), pngBytes('乙2').toString('base64')].sort());
    expect(pin.draws(), '三次摇名（1 正常 + 1 撞名 + 1 重摇）—— 重放没有多复制一份（物理落盘在 mutate 之外）')
      .toBe(3);
    console.log('[批10 实测·T6] 同毫秒两次 add-image：images=' + JSON.stringify(refs)
      + ' ｜ assets=' + JSON.stringify(listDir(path.join(projDir('b10-t6'), 'assets'))) + ' ｜ 摇名=' + pin.draws());
  });

  it('T7 单源：同一注入条件下，`import-md` 那条路与 `add-image` 那条路摇出的名字**逐字节相同**', () => {
    expect(run(['init', 'b10-t7']).code).toBe(0);
    const dir = mkSource('b10-t7');
    fs.writeFileSync(path.join(dir, 'assets', 'src-a.png'), pngBytes('甲3'));
    fs.writeFileSync(path.join(dir, 'assets', 'src-b.png'), pngBytes('乙3'));
    const md = writeMd(dir, 'one.md', ['# 单源章', '', '![图：甲](assets/src-a.png)', '']);

    /* 两条路各跑在**自己的项目**里（两个项目名）—— 否则第二条会在第一条刚落的那份文件上撞名，
     * 名字就被"重摇"改掉，等价断言失去意义。两边**同一个注入条件**（同一个毫秒 + 同一个常量随机）：
     * `import-md` 建树时先抽一次给节点 id（`markdown.idGen`）、之后那次才给资源名；`add-image` 只抽
     * 一次、直接给资源名。常量让两条路**各自那一次都拿到同一个值**，于是"是不是同一个函数"成为
     * 可判别的：谁在 assets.js 里又写一份命名（或顺手改了形状），两边的名字就不再逐字节相同。 */
    expect(run(['init', 'b10-t7a']).code).toBe(0);
    expect(run(['init', 'b10-t7b']).code).toBe(0);
    const pinA = pinNaming(MS, SAME);
    let ra = null;
    try { ra = run(['import-md', 'b10-t7a', md, '--parent', 'root']); } finally { pinA.restore(); }
    expect(ra.code, ra.stdout).toBe(0);
    const viaImport = refsOf('b10-t7a').filter((x) => x.kind === 'image').map((x) => x.file);

    const pinB = pinNaming(MS, SAME);                 // **同一个**注入条件，走另一条路（另一个项目，不撞名）
    let rb = null;
    try { rb = run(['add-image', 'b10-t7b', 'root', '--file', path.join(dir, 'assets', 'src-b.png'), '--caption', '乙']); }
    finally { pinB.restore(); }
    expect(rb.code, rb.stdout).toBe(0);
    const viaAdd = refsOf('b10-t7b').filter((x) => x.kind === 'image').map((x) => x.file);

    expect(viaImport).toHaveLength(1);
    expect(viaAdd, 'add-image 那条路**只**落了一条引用（另一条是同名判据的对象）').toHaveLength(1);
    expect(fs.readFileSync(path.join(projDir('b10-t7b'), viaAdd[0])), '两边复制的都是各自那条源文件')
      .toEqual(pngBytes('乙3'));
    /* ⚠️ 数的是全局 `Math.random` 的**全部消耗**（id 生成也算），所以两边数字**不**相等（2 vs 1）——
     * 它是"两条路都真摇了名"的前置证据，不是判据；判据是下面那句名字逐字节相同。
     * （实读：`newResourceName` 每次只吃 **1** 个随机数 —— `Date.now().toString(36)` 已经提供 8 个字符，
     *  4 位随机 = `Math.random().toString(36).slice(2, 6)` 一次取值。） */
    expect(pinA.draws(), 'import-md 那条路：节点 id 抽 1 次 + 资源名 1 次').toBe(2);
    expect(pinB.draws(), 'add-image 只复制一个文件 ⇒ 只吃资源名这一次随机').toBe(1);
    console.log('[批10 实测·T7] import-md 摇出 ' + viaImport[0] + '（全局随机消耗 ' + pinA.draws() + ' 次）'
      + ' ；add-image 摇出 ' + viaAdd[0] + '（' + pinB.draws() + ' 次）'
      + ' ｜ 判据 = 两条路各自摇出的**那一个名字**逐字节相同');
    expect(viaAdd[0], '同一个注入条件下两条路摇出的名字必须**逐字节相同**'
      + '（谁把命名规则复制回 assets.js 一份，这条就会红 —— 那是第二份实现）').toBe(viaImport[0]);
    expect(viaImport[0], '名字形状仍是被钉住的那一个（4 位随机 = SAME 的 36 进制那 4 位）')
      .toBe('assets/' + MS.toString(36) + 'i.png');
  });

  it('T8 真调到**那一处**（可达的注入缝）：`assets.js` 两条路都交给那一处、用它的返回值落盘', () => {
    expect(run(['init', 'b10-t8']).code).toBe(0);
    const dir = mkSource('b10-t8');
    fs.writeFileSync(path.join(dir, 'assets', 'a.png'), pngBytes('甲4'));
    fs.writeFileSync(path.join(dir, 'assets', 'b.png'), pngBytes('乙4'));
    fs.writeFileSync(path.join(dir, 'attachments', 'a.bin'), textBytes('附件4'));
    const md = writeMd(dir, 'one.md', ['# 哨兵章', '', '![图：甲](assets/a.png)', '']);
    const realName = markdown.newResourceName;
    const realPath = markdown.uniqueResourcePath;
    const hits = [];                            // {where, dir, ext, out}
    const note = (where) => ({ where: where, dir: null, ext: null, out: null });
    /* ⚠️ 只对 `assets.js` 那条路**可达**：`cli/commands/assets.js` 是 `markdown.uniqueResourcePath(dir, ext)`
     * 这种**模块属性调用**（与 `cli/commands/project.js` 调 `markdown.resolveImportRefs` 同一个写法），
     * 所以换掉导出项对它生效。`src/markdown.js` 内部（`resolveImportRefs` → `uniqueResourcePath`）
     * 用的是**闭包引用**，换导出项拦不住 —— 这正是上面那条静态断言的 AST 分析要覆盖的那一半。
     * 于是本用例能证的、也只证："assets.js 的两条路都真的把参数交给了那一处、并用它的返回值落盘"。 */
    markdown.uniqueResourcePath = function (d, ext) {
      const out = realPath(d, ext);
      const h = note('markdown.uniqueResourcePath');
      h.dir = d; h.ext = ext; h.out = out;
      hits.push(h);
      return out;
    };
    let beforeImport = 0; let beforeAdd = 0; let rImport = null; let rAdd = null; let rFile = null;
    try {
      beforeImport = hits.length;
      rImport = run(['import-md', 'b10-t8', md, '--parent', 'root']);
      beforeAdd = hits.length;
      rAdd = run(['add-image', 'b10-t8', 'root', '--file', path.join(dir, 'assets', 'b.png'), '--caption', '乙']);
      rFile = run(['add-file', 'b10-t8', 'root', '--file', path.join(dir, 'attachments', 'a.bin'), '--caption', '附件']);
    } finally {
      markdown.newResourceName = realName;
      markdown.uniqueResourcePath = realPath;
    }

    expect(rImport.code, rImport.stdout).toBe(0);
    expect(rAdd.code, rAdd.stdout).toBe(0);
    expect(rFile.code, rFile.stdout).toBe(0);
    expect(markdown.newResourceName, '哨兵必须已还原（否则后面的用例都在打桩状态下跑）').toBe(realName);
    expect(markdown.uniqueResourcePath).toBe(realPath);
    expect(hits.length - beforeAdd, '`add-image` / `add-file` 各**一次**（1+1）——'
      + '谁在 assets.js 里又写一份命名/闸，这里就是 0').toBe(2);
    expect(beforeImport, 'import-md 那条路**拦不到**（它在闭包里、用的是模块内部引用）：'
      + '如实登记 —— 这一项不是判据，只是把"可注入 / 不可注入"的边界写清楚').toBe(0);
    expect(hits.filter((h) => !h.ext).length, '两次命中都带着调用方给的扩展名 ⇒ 没有 id 那条路混进来').toBe(0);
    expect(hits.map((h) => h.ext).sort(), '扩展名由各自调用方给（图片 .png / 附件 .bin）')
      .toEqual(['.bin', '.png']);
    /* **返回值真的被用了**：若谁把 `assets.js` 改成"自己造名字、只随手调一下那一处"，落盘的引用
     * 就不会等于那一处返回的名字 ⇒ 这一条红。 */
    const lands = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch (e) { return false; } };
    hits.forEach((h, i) => {
      expect(lands(h.out), '第 ' + (i + 1) + ' 次命中返回的名字必须真落盘: ' + h.out).toBe(true);
    });
    const refBases = refsOf('b10-t8').map((x) => path.basename(x.file));
    hits.forEach((h) => {
      expect(refBases, '落盘的引用里必须有那一处返回的名字: ' + path.basename(h.out))
        .toContain(path.basename(h.out));
    });
    console.log('[批10 实测·T8] assets 那条路命中"到处唯一的那一个函数" 2 次（add-image 1 / add-file 1），'
      + '每次返回的名字都真落了盘=' + JSON.stringify(hits.map((h) => path.basename(h.out)))
      + ' ｜ import-md 那条路命中 0 次（闭包引用、**不可注入** —— 由上面的静态"全树唯一 + 全树只有一次 return"断言覆盖）');
  });

  it('T9 撞名**绝不覆盖**、名字摇不动 ⇒ 响亮报错（不死循环）且给出路：物理零副作用', () => {
    expect(run(['init', 'b10-t9']).code).toBe(0);
    const dir = mkSource('b10-t9');
    fs.writeFileSync(path.join(dir, 'assets', 'a.png'), pngBytes('源9'));
    const takenPath = seedTaken(path.join(projDir('b10-t9'), 'assets'), PINNED + '.png', pngBytes('占位9'));
    const before = fs.readFileSync(projFile('b10-t9'), 'utf8');
    const pin = pinNaming(MS, SAME, 64);        // 名字**永远**是同一个 ⇒ 重摇也撞（预算 64 防"挂死"）
    let r = null;
    try { r = run(['add-image', 'b10-t9', 'root', '--file', path.join(dir, 'assets', 'a.png'), '--caption', '图']); }
    finally { pin.restore(); }

    expect(r.code, '必须 exit≠0（响亮）').toBe(1);
    expect(r.stdout).toContain('撞上盘上已存在的文件');
    expect(r.stdout, '报错要指回唯一的修法现场').toContain('newResourceName');
    expect(r.stdout, '出路：说清"没落盘、也没写进节点"，并给出可执行的重跑建议').toContain('出路：本次 图片 没有落盘');
    expect(r.stdout).toContain('重跑一次这条命令');
    expect(fs.readFileSync(takenPath), '被占的那个文件**一个字节都没改**').toEqual(pngBytes('占位9'));
    expect(listDir(path.join(projDir('b10-t9'), 'assets')), '没有多出第二个文件、也没留下临时物').toEqual([PINNED + '.png']);
    expect(fs.readFileSync(projFile('b10-t9'), 'utf8'), '报错发生在写数据之前 ⇒ 项目文件逐字节没动').toBe(before);
    expect(pin.draws(), '重摇有上界（8 次）⇒ 摇名次数有限，报错**及时**').toBeLessThanOrEqual(16);
    console.log('[批10 实测·T9] exit=' + r.code + ' ｜ 摇名次数=' + pin.draws() + '（上界=8 ⇒ 不是死循环）'
      + ' ｜ 报文：' + r.stdout.replace(/\n/g, ' ').slice(0, 220));
  });

  it('T10 附件那条路同样有闸（`add-file`：撞名也重摇、不覆盖 —— 两条路都补到，不是只补图片）', () => {
    expect(run(['init', 'b10-t10']).code).toBe(0);
    const dir = mkSource('b10-t10');
    fs.writeFileSync(path.join(dir, 'attachments', 'one.md'), textBytes('甲10'));
    fs.writeFileSync(path.join(dir, 'attachments', 'two.md'), textBytes('乙10'));
    const takenPath = seedTaken(path.join(projDir('b10-t10'), 'attachments'), PINNED + '.md', textBytes('占位10'));
    const pin = pinNaming(MS, [SAME, SAME]);
    let a = null; let b = null;
    try {
      a = run(['add-file', 'b10-t10', 'root', '--file', path.join(dir, 'attachments', 'one.md'), '--caption', '甲']);
      b = run(['add-file', 'b10-t10', 'root', '--file', path.join(dir, 'attachments', 'two.md'), '--caption', '乙']);
    } finally { pin.restore(); }

    expect(a.code, a.stdout).toBe(0);
    expect(b.code, b.stdout).toBe(0);
    const refs = refsOf('b10-t10').filter((x) => x.kind === 'file').map((x) => x.file);
    expect(new Set(refs).size, '两个附件必须落在**不同**的名字上').toBe(2);
    ['甲10', '乙10'].forEach((tag, i) => {
      expect(fs.readFileSync(path.join(projDir('b10-t10'), refs[i])), '第 ' + (i + 1) + ' 个附件 = 它自己的源文件')
        .toEqual(textBytes(tag));
    });
    expect(fs.readFileSync(takenPath), '被占的那份附件一字不改').toEqual(textBytes('占位10'));
    expect(listDir(path.join(projDir('b10-t10'), 'attachments')).length, '占位 1 + 两份附件 = 3').toBe(3);
    console.log('[批10 实测·T10] 附件撞名：files=' + JSON.stringify(refs)
      + ' ｜ attachments=' + JSON.stringify(listDir(path.join(projDir('b10-t10'), 'attachments'))));
  });

  it('T11 注入证明（**不碰产品文件**）：把唯一性闸还原成旧行为 ⇒ T1 同一批断言必红，两份内容少一份', () => {
    expect(run(['init', 'b10-t11']).code).toBe(0);
    const dir = mkSource('b10-t11');
    fs.writeFileSync(path.join(dir, 'assets', 'jia.png'), pngBytes('甲11'));
    fs.writeFileSync(path.join(dir, 'assets', 'yi.png'), pngBytes('乙11'));
    /* 占位文件刻意用**另一个毫秒**造的名字（`MS + 1000` ⇒ `p80` 后缀）：
     * 本用例的随机源是钉死的（时间 = MS、4 位随机只可能取 `i` / `4i`），所以占位名**不在可达集合**里 ——
     * 这样"占位文件一字不改"才真的在验"绝不覆盖"，而不是靠运气。 */
    const seedName = (MS + 1000).toString(36) + (SAME).toString(36).slice(2, 6) + '.png';
    const takenPath = seedTaken(path.join(projDir('b10-t11'), 'assets'), seedName, pngBytes('占位11'));    const realPath = markdown.uniqueResourcePath;
    /* 旧行为 = 修前 assets.js 那两行（**不含任何唯一性检查**）：名字照样摇、照样复制，撞了就覆盖。
     * 注入点是**模块导出项** —— `assets.js` 走的是属性调用（与 T8 同一条缝），所以这一针扎到的是
     * "那道闸"本身，而不是"产品的哪一行"。为什么用这种注入而**不去改产品文件**：改文件那种注入
     * 需要在跑测试的中途写盘，一旦恢复那一步出岔子（本会话就出过一次：写回被 UTF-8 BOM 污染），
     * 留下的是一半注入的源码 —— **注入证明的成本不该由产品代码承担**。这一针在 finally 里还原。 */
    markdown.uniqueResourcePath = (d, ext) => path.join(d, Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + ext);
    const pin = pinNaming(MS, [SAME, SAME, 0.125], 0, [0.03125]);
    let a = null; let b = null;
    try {
      a = run(['add-image', 'b10-t11', 'root', '--file', path.join(dir, 'assets', 'jia.png'), '--caption', '甲']);
      b = run(['add-image', 'b10-t11', 'root', '--file', path.join(dir, 'assets', 'yi.png'), '--caption', '乙']);
    } finally { pin.restore(); markdown.uniqueResourcePath = realPath; }

    expect(markdown.uniqueResourcePath, '注入必须已还原').toBe(realPath);
    expect([a.code, b.code], '旧行为下两条命令都"成功"（exit 0 + 回显"已添加图片"）—— 正是最坏的一种：'
      + '报错都没有，只是有一份数据没了').toEqual([0, 0]);
    const refs = refsOf('b10-t11').filter((x) => x.kind === 'image').map((x) => x.file);
    const oldShape = 'assets/' + MS.toString(36) + 'i.png';        // 旧行为会摇出来的名字（无闸 ⇒ 不查重）
    expect(refs, '旧行为：两次都落在**同一个名字**上（第二次 copyFileSync 覆盖第一次）').toEqual([oldShape, oldShape]);
    expect(oldShape, '前置条件：旧行为摇出的名字**不是**那个占位名（否则"占位没被改"这条就是空话）')
      .not.toBe('assets/' + seedName);
    expect(listDir(path.join(projDir('b10-t11'), 'assets')),
      '旧行为：盘上只有 1 份新建的文件（两次复制塌成一份）+ 占位 1 份 ——'
      + '所以【批10】T1 那句"两条引用名字不同"在这一状态下必红').toEqual([seedName, oldShape.split('/')[1]].sort());
    expect(fs.readFileSync(path.join(projDir('b10-t11'), oldShape)),
      '塌成的那一份里是**乙**（第二次复制的源文件）').toEqual(pngBytes('乙11'));
    expect(fs.readFileSync(path.join(projDir('b10-t11'), oldShape)), '**甲的内容已经不在盘上了** —— 这就是那个静默丢数据')
      .not.toEqual(pngBytes('甲11'));
    expect(fs.readFileSync(takenPath), '占位那份（名字与本次摇出来的都不同）在两版行为下都一字不改')
      .toEqual(pngBytes('占位11'));
    console.log('[批10 实测·T11] 去掉唯一性闸（旧行为）= 两条命令 exit 0、**两条引用同名** ' + JSON.stringify(refs)
      + '、盘上 assets=' + JSON.stringify(listDir(path.join(projDir('b10-t11'), 'assets')))
      + ' ⇒ 甲的内容静默消失（T1 的"名字不同/两份内容"那批断言在这一状态下必红；本用例就是那个红状态的确定性复现）');
  });
});
