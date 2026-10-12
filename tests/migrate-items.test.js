/* ============================================================
 * tests/migrate-items.test.js — v2 → v3 条目层迁移（S1）端到端
 * 运行：npx vitest run tests/migrate-items.test.js
 * ------------------------------------------------------------
 * ## 这个文件守什么（每条都对着一个**能红**的判据，契约 `docs/ITEM-MODEL.md` §6）
 *   A. **dry-run 如实**：`--dry-run --json` 列出"将迁移 / 将跳过"（**逐节点点名**）、
 *      `exit 0`、**盘上零改动**（逐字节）、且**不备份**；不在迁移范围的节点（无 `<li>` 无 qa）不算"跳过"。
 *   B. **真跑**：`exit 0` + `validate` exit 0 + `meta.formatVersion === 3` +
 *      被迁移节点 `detail === renderDetail(items)`（**逐字节**）+ **内容未变**（原 detail 逐字节相同）+
 *      **写盘前自动备份**（绝对路径、与 `export-json` 同一实现、用 `import-json` 真能恢复回 v2）。
 *   C. **`qa[]` 收敛**：节点的 `qa` 键**消失**、内容变成 `type:'qa'` 条目（保序追加、`item.qa` 原样）。
 *   D. **幂等**：第二次跑 `changed:{nodes:0,items:0}`、`itemized:0`、**文件逐字节不变**（一次盘都不写）。
 *   E. **准入门槛的判别力证明**（注入）：把 `parseDetail` 换成有损实现 ⇒ 那个节点必须**跳进 skipped**
 *      并**一个字节都不动**（而不是"修一下再写"）；撤销注入后同一节点照常迁移。
 *   F. **位置参数陷阱**（契约 §6 顶部那条实测）：`migrate items <项目>` 的项目名是 `args._[1]` ——
 *      报"项目不存在"时必须报**真项目名**，不能报 `items`；缺项目名/子命令写错时给用法。
 *   G. 迁移**不写 `detailMode`**、**不碰**已显式声明富文本的节点（§2 互斥），并在报告里点名。
 *
 * ## 环境纪律
 *   1) **绝不许碰真实 `projects/`**：`AI_MINDMAP_PROJECTS_DIR` 在 require `cli/main.js` **之前**设好
 *      （`cli/core.js` 的 `PROJECTS_DIR` 是模块加载时定型的），并在加载后**当场自证**重定向生效；
 *   2) **不起子进程**：进程内 `invokeSync`（与 tests/item-commands.test.js 同口径）；
 *   3) `cli/registry.js` 的 register 行归 **I** 落盘（本文件只交原文）⇒ 这里用 registry 的公开 API
 *      **自注册一次**，I 落盘后自动跳过（两处原文逐字相同，`REGISTER_LINE` 是唯一来源）；
 *   4) 备份落在工程的 `.review/<YYYYMMDD>-条目层迁移/`（契约 §6 钉死的位置，`.review/` 进 gitignore）——
 *      收尾只删本文件造的那几个 `<it-s1-*>.aimap.json`。
 * ============================================================ */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/* ---- ① 临时项目根（必须在 require cli/main.js 之前） ---- */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-s1-migrate-'));
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const registry = require('../cli/registry.js');
const migrateCmd = require('../cli/commands/migrate.js');
const M = require('../src/item-model.js');
const bundle = require('../src/bundle.js');

/* 重定向必须**当场**生效：否则夹具会建进真实 `projects/`。宁可在这里响亮地红。 */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效（cli/core.js 已被更早加载）：PROJECTS_DIR='
    + core.PROJECTS_DIR + ' 期望=' + SANDBOX + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

/* ============================================================================
 * ② 交付给 I 的 registry 原文（**唯一来源**：既是自注册用的常量，也是交付②的内容）
 * ==========================================================================
 * ⚠️ usage 与 options 必须一一对上（`tests/cli-options.test.js` 机械核对）：
 *    usage 里出现的每个 `--x` 都要在 options 里；options 里每一项也都要出现在 usage 里。
 * ========================================================================== */
const REGISTER_LINE = {
  name: 'migrate',
  usage: 'migrate items <项目> [--dry-run] [--json]',
  options: ['dryRun', 'json'],
  desc: '把 v2 节点的 detail **无损**迁成条目层 items（v2 → v3）：只迁"能逐字节回放"的节点，'
    + '其余整节点跳过并逐条点名（不许"修一下再写"）；`qa[]` 收敛成 `type:\'qa\'` 条目后删掉 `qa` 键；'
    + '写盘前自动 `export-json` 一份到 `.review/<日期>-条目层迁移/` 并打印绝对路径（**没有跳过备份的开关**）；'
    + '`meta.formatVersion` → 3（validate 同时接受 2 与 3）。幂等：第二次跑 `changed:{nodes:0,items:0}`',
  fn: migrateCmd.migrate
};
if (!registry.get(REGISTER_LINE.name)) registry.register(REGISTER_LINE);

/* ============================================================================
 * ③ 夹具
 * ========================================================================== */
const P = 'it-s1-migrate';
const P_RESTORE = 'it-s1-restore';
/** 可无损回放：多个顶层块 + 列表组 + 块间空白（真实数据里最常见的那种） */
const DETAIL_OK = '<h3>标题</h3>\n<ul>\n<li>甲</li>\n<li>乙</li>\n</ul>\n<p>收尾</p>';
/** **不可**回放：根层裸文本（没有条目能承载它）⇒ 必须整节点跳过 */
const DETAIL_BAD = '<ul>\n<li>甲</li>\n</ul>\n根层裸文本\n<p>尾</p>';
/** 显式声明为富文本（detailMode）⇒ 与条目层互斥，迁移不碰 */
const DETAIL_RICH = '<table>\n<tr><td>表</td></tr>\n</table>\n<ul><li>富文本里的 li</li></ul>';
/** 无 `<li>` 也无 qa ⇒ **不在迁移范围**（既不是迁移，也不是跳过） */
const DETAIL_PLAIN = '<p>只有段落</p>';
const DETAIL_QA = '<p>问答节点的前言</p>';
const QA_ENTRY = { q: '为什么', a: '因为', at: '2026-10-01T00:00:00.000Z', model: 'test-model' };

const N_OK = 'it-s1-ok', N_BAD = 'it-s1-bad', N_RICH = 'it-s1-rich',
  N_QA = 'it-s1-qa', N_PLAIN = 'it-s1-plain';

const projFile = (name) => path.join(SANDBOX, name, name + '.json');
const bytes = (name) => fs.readFileSync(projFile(name || P));              // Buffer：**逐字节**判据
const readJson = (name) => JSON.parse(fs.readFileSync(projFile(name || P), 'utf8').replace(/^\uFEFF/, ''));
const node = (id, name) => (function w(n) {
  if (!n) return null;
  if (n.id === id) return n;
  for (const c of (n.children || [])) { const r = w(c); if (r) return r; }
  return null;
})(readJson(name).data);
/** 跑一条命令（进程内同步）：返回 { code, out }（stdout + stderr 合并，与集成脚本同口径） */
function run(...args) {
  const r = invokeSync(args);
  return { code: r.code, out: (r.stdout + r.stderr).trim() };
}
const asJson = (out) => { try { return JSON.parse(out); } catch (e) { return null; } };
/** 备份目录（契约 §6 钉死的位置与命名：`.review/<YYYYMMDD>-条目层迁移/<项目>.aimap.json`） */
function backupPathOf(name) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate());
  return path.join(path.resolve(__dirname, '..'), '.review', stamp + '-条目层迁移', name + '.aimap.json');
}
/** 去掉条目层与派生缓存之后的"其它字段"（AC4：迁移除这几样之外不许改任何东西） */
function withoutItemLayer(project) {
  const o = JSON.parse(JSON.stringify(project));
  const strip = (n) => {
    if (!n || typeof n !== 'object') return;
    delete n.items; delete n.detail; delete n.qa;
    (n.children || []).forEach(strip);
  };
  strip(o.data);                      // ⚠️ 从**根节点**开始（整份数据是 {meta, format, data}）
  delete o.meta.formatVersion;        // 版本号是**唯一允许**的差异（契约 §3.3 的读兼容承诺），单独断言
  return o;
}

let snapshotBefore = null;

beforeAll(() => {
  expect(path.resolve(core.PROJECTS_DIR)).toBe(path.resolve(SANDBOX));
  expect(run('init', P, '--title', 'S1 迁移探针').code).toBe(0);
  expect(run('add', P, 'root', '--id', N_OK, '--topic', '可回放节点', '--detail', DETAIL_OK).code).toBe(0);
  expect(run('add', P, 'root', '--id', N_BAD, '--topic', '不可回放节点', '--detail', DETAIL_BAD).code).toBe(0);
  expect(run('add', P, 'root', '--id', N_RICH, '--topic', '富文本节点', '--detail', DETAIL_RICH).code).toBe(0);
  expect(run('add', P, 'root', '--id', N_QA, '--topic', '问答节点', '--detail', DETAIL_QA).code).toBe(0);
  expect(run('add', P, 'root', '--id', N_PLAIN, '--topic', '没列表的节点', '--detail', DETAIL_PLAIN).code).toBe(0);
  /* `qa[]` 与 `detailMode` 的写入点不在本命令的面上（前者归 ask-apply、后者归 edit），
   * 这里**只造数据形状**（与 cli-integration §48 造一条 links[].item 同一做法：判据看形状，不看谁写的）。 */
  const d = readJson();
  const qaNode = (function w(n) {
    if (!n) return null; if (n.id === N_QA) return n;
    for (const c of (n.children || [])) { const r = w(c); if (r) return r; } return null;
  })(d.data);
  qaNode.qa = [JSON.parse(JSON.stringify(QA_ENTRY))];
  const richNode = (function w(n) {
    if (!n) return null; if (n.id === N_RICH) return n;
    for (const c of (n.children || [])) { const r = w(c); if (r) return r; } return null;
  })(d.data);
  richNode.detailMode = 'rich';
  fs.writeFileSync(projFile(P), JSON.stringify(d, null, 2), 'utf8');
  // 夹具自身必须先是合法数据（否则后面的红分不清是迁移的错还是夹具的错）
  expect(run('validate', P).code).toBe(0);
  snapshotBefore = readJson();
});

afterAll(() => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* 收尾失败不影响判定 */ }
  // 只删本文件造的那几个备份（契约要求备份落在工程的 .review 下 ⇒ 测试也要自己收干净）
  [P, P_RESTORE].forEach((n) => {
    try { fs.rmSync(backupPathOf(n), { force: true }); } catch (e) { /* ignore */ }
  });
  try {
    const dir = path.dirname(backupPathOf(P));
    // 本命令**还会往目录里写一份自述 README.md**（G8 的判据；产品行为，见 `cli/commands/migrate.js`
    // 的 `backupReadmeText`）。只删"仅剩自述"的那种目录 —— 里面有**别人的**备份文件时一律不动。
    if (fs.existsSync(dir) && fs.readdirSync(dir).join(',') === 'README.md') {
      fs.rmSync(path.join(dir, 'README.md'), { force: true });
    }
    if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
  } catch (e) { /* ignore */ }
});

/* ============================================================================
 * A. dry-run：如实列举，盘上零改动
 * ========================================================================== */
describe('S1 迁移 · A. --dry-run（如实列举 + 盘上零改动）', () => {
  let report = null;

  it('--dry-run --json：exit 0、stdout 是**一份**可解析 JSON、字段与契约 §6 的报告形状一致', () => {
    const before = bytes();
    const r = run('migrate', 'items', P, '--dry-run', '--json');
    expect(r.code).toBe(0);
    report = asJson(r.out);
    expect(report, 'stdout 必须是一份可解析 JSON：' + r.out.slice(0, 200)).not.toBeNull();
    expect(Object.keys(report).sort()).toEqual([
      'backup', 'changed', 'itemized', 'items', 'ok', 'project', 'scanned', 'skipped'
    ]);
    expect(report.ok).toBe(true);
    expect(report.project).toBe(P);
    expect(bytes().equals(before), 'dry-run 必须盘上零改动').toBe(true);
  });

  it('"将迁移 / 将跳过"都**点名**：可回放的 2 个（可回放节点 + 问答节点）、跳过的 2 个各带原因', () => {
    expect(report.scanned).toBe(6);                        // root + 5 个夹具节点
    expect(report.itemized).toBe(2);
    expect(report.items).toBe(6);                          // 4 条（可回放节点）+ 1 解析 + 1 qa（问答节点）
    expect(report.changed).toEqual({ nodes: 2, items: 6 });
    const byId = new Map(report.skipped.map((s) => [s.nodeId, s.reason]));
    expect(Array.from(byId.keys()).sort()).toEqual([N_BAD, N_RICH].sort());
    expect(byId.get(N_BAD)).toContain('不可逐字节回放');     // 逐条点名 + 原因
    expect(byId.get(N_RICH)).toContain('detailMode');        // 显式富文本：不碰它，但要说出来
    // 不在迁移范围的节点**不算**跳过（否则"跳过"会被稀释成没有信息量的东西）
    expect(byId.has(N_PLAIN)).toBe(false);
  });

  it('dry-run **不备份**（契约 §6：--dry-run 只出报告，不写盘、不备份）', () => {
    expect(report.backup).toBeNull();
    expect(fs.existsSync(backupPathOf(P))).toBe(false);
  });

  it('文本形态同样如实（说清是预览、盘上零改动，并逐条点名跳过项）', () => {
    const before = bytes();
    const r = run('migrate', 'items', P, '--dry-run');
    expect(r.code).toBe(0);
    expect(r.out).toContain('--dry-run');
    expect(r.out).toContain('盘上零改动');
    expect(r.out).toContain(N_BAD);
    expect(r.out).toContain(N_RICH);
    expect(bytes().equals(before)).toBe(true);
  });
});

/* ============================================================================
 * B. 真跑：写盘 + 一致性 + 备份
 * ========================================================================== */
describe('S1 迁移 · B. 真跑（写盘 / 一致性 / 备份可回退）', () => {
  let report = null;

  it('真跑 exit 0；报告与 dry-run 的预演**同一份数**；备份是绝对路径且真的落在契约指的位置', () => {
    const r = run('migrate', 'items', P, '--json');
    expect(r.code).toBe(0);
    report = asJson(r.out);
    expect(report.ok).toBe(true);
    expect(report.changed).toEqual({ nodes: 2, items: 6 });
    expect(report.itemized).toBe(2);
    expect(path.isAbsolute(report.backup), '备份路径必须是绝对路径：' + report.backup).toBe(true);
    expect(report.backup).toBe(backupPathOf(P));
    expect(fs.existsSync(report.backup)).toBe(true);
  });

  it('备份目录里有**自述** README.md（G8 的判据就是"`.review/*/README.md` 存在" ⇒ 少了它下一次全链必红）', () => {
    // 判据来源：`scripts/docs-registry-check.js` 的 `checkWorkDirStatus` —— `.review/` 的**直接子目录**
    // 必须有 `README.md`（G8 报文原话："补三行（主题 / 开始日期 / 状态：在飞|已收口|已废弃）"）。
    // 本命令跑一次就会**当场新建一个目录** ⇒ 自述必须由产品写：实测过的后果是"跑迁移那次全绿、
    // 下一次全链在 G8 红"（G8 步 2 / G4 步 12），且绿的那次看不出任何异常。
    const readme = path.join(path.dirname(backupPathOf(P)), 'README.md');
    expect(fs.existsSync(readme), '备份目录缺自述：' + readme).toBe(true);
    const md = fs.readFileSync(readme, 'utf8');
    expect(md).toContain('主题:');                                  // 三行状态（G8 报错文案点名要的）
    expect(md).toMatch(/开始日期: \d{4}-\d{2}-\d{2}/);
    expect(md).toMatch(/状态: (在飞|已收口|已废弃)/);
    expect(md).toContain('import-json');                            // 怎么回退（要能直接照抄）
    expect(md).toContain('.review/');                               // 不进版本库 / 能整目录删
  });

  it('迁移后 validate exit 0（G2 绿）+ `meta.formatVersion === 3`', () => {
    const v = run('validate', P);
    expect(v.code, v.out).toBe(0);
    expect(readJson().meta.formatVersion).toBe(3);
  });

  it('被迁移节点：`detail === renderDetail(items)` **逐字节**，且原 detail 逐字节未变（不改内容）', () => {
    const ok = node(N_OK);
    expect(Array.isArray(ok.items)).toBe(true);
    expect(ok.detail).toBe(M.renderDetail(ok.items));      // 派生缓存一致
    expect(ok.detail).toBe(DETAIL_OK);                     // ★ 准入门槛的正面判据：内容一个字节都没变
    expect(ok.items.map((x) => x.html)).toEqual(['<h3>标题</h3>', '<li>甲</li>', '<li>乙</li>', '<p>收尾</p>']);
    // 并发/门禁都认的正是这条等式；顺带证明 `_` 起头的解析期字段**必须**能落盘（否则回放不了）
    ok.items.forEach((x) => expect(M.validateItems([x])).toEqual([]));
  });

  it('跳过的节点**一个字节都没动**：不可回放节点保持 v2 形态；富文本节点连 detailMode 都原样', () => {
    const bad = node(N_BAD);
    expect(bad.items).toBeUndefined();
    expect(bad.detail).toBe(DETAIL_BAD);
    const rich = node(N_RICH);
    expect(rich.items).toBeUndefined();                    // 迁移**不写** detailMode、也不拿 items 换掉它
    expect(rich.detailMode).toBe('rich');
    expect(rich.detail).toBe(DETAIL_RICH);
    const plain = node(N_PLAIN);
    expect(plain.items).toBeUndefined();
    expect(plain.detail).toBe(DETAIL_PLAIN);
  });

  it('除 `items` / `detail` / `qa` / `meta.formatVersion` 外，整份数据**逐字节不变**（AC4 的口径）', () => {
    const after = readJson();
    expect(after.meta.formatVersion).toBe(3);
    expect(snapshotBefore.meta.formatVersion).toBe(2);
    expect(withoutItemLayer(after)).toEqual(withoutItemLayer(snapshotBefore));
  });

  it('备份是一份**能恢复回 v2** 的 aimap（与 `export-json` 同一实现 ⇒ `import-json` 真能导回来）', () => {
    const packed = asJson(fs.readFileSync(backupPathOf(P), 'utf8'));
    expect(packed).not.toBeNull();
    const parsed = bundle.parseBundle(fs.readFileSync(backupPathOf(P), 'utf8'));
    expect(parsed.ok, parsed.error).toBe(true);
    expect(packed.meta.formatVersion).toBe(2);                            // 回退路的依据
    const imp = run('import-json', backupPathOf(P), '--name', P_RESTORE);
    expect(imp.code, imp.out).toBe(0);
    expect(run('validate', P_RESTORE).code).toBe(0);
    const restored = node(N_OK, P_RESTORE);
    expect(restored.items).toBeUndefined();                               // 恢复出来的是**迁移前**那份
    expect(restored.detail).toBe(DETAIL_OK);
    expect(readJson(P_RESTORE).meta.formatVersion).toBe(2);
  });
});

/* ============================================================================
 * C. qa[] 收敛
 * ========================================================================== */
describe('S1 迁移 · C. `qa[]` 收敛（键消失 + 内容变成 type:\'qa\' 条目）', () => {
  it('节点 `qa` 键**消失**；内容成为 `type:\'qa\'` 条目，且 `item.qa` 与 v2 记录**逐字段相同**', () => {
    const qa = node(N_QA);
    expect(qa.qa).toBeUndefined();                        // 不留只读副本（两处表达必漂移）
    expect(qa.items.map((x) => x.type)).toEqual(['rich', 'qa']);   // 解析产物在前、qa **保序追加**在后
    expect(qa.items[1].qa).toEqual(QA_ENTRY);             // q / a / at / model 原样进 item.qa
    expect(qa.items[0].html).toBe(DETAIL_QA);
    expect(qa.detail).toBe(M.renderDetail(qa.items));      // detail 是派生缓存（含 qa 段渲染）
    expect(qa.detail.startsWith(DETAIL_QA)).toBe(true);    // 原内容仍在最前面
  });

  it('qa 条目由 `src/qa.js` 渲染（**不复制**那段逻辑）：条目渲染结果与 `appendHtml` 逐字节一致', () => {
    const qa = node(N_QA);
    const qaModule = require('../src/qa.js');
    expect(typeof qaModule.appendHtml).toBe('function');
    expect(M.renderDetail([qa.items[1]])).toBe(qaModule.appendHtml(qa.items[1].qa));
  });
});

/* ============================================================================
 * D. 幂等
 * ========================================================================== */
describe('S1 迁移 · D. 幂等（第二次跑：0 改动 + 文件逐字节不变）', () => {
  it('第二次 `--json`：`changed:{nodes:0,items:0}`、`itemized:0`、`backup:null`、exit 0', () => {
    const before = bytes();
    const r = run('migrate', 'items', P, '--json');
    expect(r.code).toBe(0);
    const rep = asJson(r.out);
    expect(rep.changed).toEqual({ nodes: 0, items: 0 });
    expect(rep.itemized).toBe(0);
    expect(rep.items).toBe(0);
    expect(rep.backup).toBeNull();                        // 没有写入 ⇒ 不产生第二份备份
    expect(bytes().equals(before), '第二次跑必须逐字节不变').toBe(true);
  });

  it('第二次的 `skipped` 仍然点名那两个节点（**"不可迁移"不许伪装成"没有需要迁移的"**）', () => {
    const rep = asJson(run('migrate', 'items', P, '--json').out);
    expect(rep.skipped.map((s) => s.nodeId).sort()).toEqual([N_BAD, N_RICH].sort());
    const txt = run('migrate', 'items', P).out;
    const firstLine = txt.split('\n')[0];
    expect(firstLine).toContain('没有可迁移的节点');        // 如实说"没有可迁移的"，不说"无需迁移"
    expect(firstLine).not.toContain('无需迁移');             // 有跳过项时**不许**用"无需迁移"糊过去
    expect(txt).toContain(N_BAD);
  });

  it('全部节点都可迁移时，第二次跑才说"无需迁移"（"无需迁移"这个词有确切含义）', () => {
    const P2 = 'it-s1-clean';
    expect(run('init', P2, '--title', 'S1 干净探针').code).toBe(0);
    expect(run('add', P2, 'root', '--id', 'it-s1-c1', '--topic', 'T', '--detail', '<ul>\n<li>x</li>\n</ul>').code).toBe(0);
    expect(run('migrate', 'items', P2).code).toBe(0);
    const before = bytes(P2);
    const second = run('migrate', 'items', P2);
    expect(second.code).toBe(0);
    expect(second.out).toContain('无需迁移');
    expect(bytes(P2).equals(before)).toBe(true);
    try { fs.rmSync(backupPathOf(P2), { force: true }); } catch (e) { /* ignore */ }
  });
});

/* ============================================================================
 * E. 准入门槛的判别力证明（注入）
 * ========================================================================== */
describe('S1 迁移 · E. 准入门槛的判别力证明（有损解析 ⇒ 必跳过、必不写）', () => {
  const P2 = 'it-s1-inject';
  const DETAIL = '<h3>标题</h3>\n<ul>\n<li>甲</li>\n</ul>';

  it('注入有损 `renderDetail`：本该迁移的节点 ⇒ 出现在 skipped 里，且盘上一个字节都没动', () => {
    expect(run('init', P2, '--title', 'S1 注入探针').code).toBe(0);
    expect(run('add', P2, 'root', '--id', 'it-s1-i1', '--topic', '注入节点', '--detail', DETAIL).code).toBe(0);
    const before = bytes(P2);
    // 对照组：不注入时它能迁移（这条断言先把"闸门在拦"的前提钉住）
    expect(asJson(run('migrate', 'items', P2, '--dry-run', '--json').out).itemized).toBe(1);
    expect(bytes(P2).equals(before)).toBe(true);

    const imPath = require.resolve('../src/item-model.js');
    const real = require.cache[imPath].exports;
    try {
      /* **有损渲染**：把标签之间的空白吃掉（`>\s+<` → `><`）⇒ 解析照常成功、回放不再逐字节。
       * ⚠️ 必须注入 `renderDetail`（而不是 `parseDetail`）：`itemizeNode` 内部调用的是模块内的
       *    `parseDetail`（不走 exports）⇒ 换 exports.parseDetail 对它毫无影响，注入会"静默无效"，
       *    那条断言就成了空转（本项目最忌的假绿）。而准入门槛的比较基准正是 exports.renderDetail。 */
      require.cache[imPath].exports = Object.assign({}, real, {
        renderDetail: (items) => String(real.renderDetail(items)).replace(/>\s+</g, '><')
      });
      const dry = asJson(run('migrate', 'items', P2, '--dry-run', '--json').out);
      expect(dry.itemized).toBe(0);
      expect(dry.skipped.map((s) => s.nodeId)).toEqual(['it-s1-i1']);
      expect(dry.skipped[0].reason).toContain('不可逐字节回放');
      const real2 = run('migrate', 'items', P2, '--json');
      expect(real2.code).toBe(0);
      const rep = asJson(real2.out);
      expect(rep.changed).toEqual({ nodes: 0, items: 0 });
      expect(bytes(P2).equals(before), '跳过 ⇒ 一个字节都不许动').toBe(true);
      expect(readJson(P2).meta.formatVersion).toBe(2);     // 零写入 ⇒ 连版本号都不动
    } finally {
      require.cache[imPath].exports = real;
    }
  });

  it('撤销注入后，同一节点照常迁移（判据不是"永远红"，而是"能红也能绿"）', () => {
    const r = run('migrate', 'items', P2, '--json');
    expect(r.code).toBe(0);
    const rep = asJson(r.out);
    expect(rep.changed).toEqual({ nodes: 1, items: 2 });
    const n = node('it-s1-i1', P2);
    expect(n.detail).toBe(M.renderDetail(n.items));
    expect(n.detail).toBe(DETAIL);
    expect(readJson(P2).meta.formatVersion).toBe(3);
    try { fs.rmSync(backupPathOf(P2), { force: true }); } catch (e) { /* ignore */ }
  });
});

/* ============================================================================
 * F. 位置参数陷阱（契约 §6 顶部那条实测）
 * ========================================================================== */
describe('S1 迁移 · F. `migrate items <项目>` 的位置参数', () => {
  it('项目不存在时报的是**真项目名**（不是 `items`）—— 直接证明命令体用的是 `args._[1]`', () => {
    const r = run('migrate', 'items', 'no-such-project-xyz', '--json');
    expect(r.code).toBe(1);
    expect(r.out.startsWith('error: ')).toBe(true);
    expect(r.out).toContain('项目不存在: no-such-project-xyz');
    expect(r.out).not.toContain('项目不存在: items');
  });

  it('缺项目名 / 子命令写错 ⇒ 给出用法（不静默、不去猜）', () => {
    const noProject = run('migrate', 'items');
    expect(noProject.code).toBe(1);
    expect(noProject.out).toContain('migrate items <项目>');
    const wrongSub = run('migrate', 'nodes', P);
    expect(wrongSub.code).toBe(1);
    expect(wrongSub.out).toContain('未知子命令');
    expect(wrongSub.out).toContain('nodes');
  });
});
