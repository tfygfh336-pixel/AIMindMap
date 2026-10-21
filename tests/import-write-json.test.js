/* ============================================================
 * tests/import-write-json.test.js — 导入三缺陷（20261022）· **缺陷 2 与缺陷 3**
 *   缺陷 2：`import-dir` 明明会写盘，却没登记在 `cli/core.js` 的 `WRITE_COMMANDS` 里
 *           ⇒ 被当成只读命令，`--idem k --dry-run` 当场被拒（exit 1）；去掉 `--idem` 又 exit 0。
 *   缺陷 3：`import-md` / `import-json` 没有 `--json`（6 条导入命令里这两条只有文本回档）。
 * 运行：npx vitest run tests/import-write-json.test.js
 * ------------------------------------------------------------
 * ## 缺陷 2 的判据（两条都要）
 *   · **清单归属**：`import-dir` 在 `WRITE_COMMANDS` 里（否则 `--idem` 的归属守门永远拒它）；
 *   · **行为**：`import-dir … --idem k --dry-run` ⇒ exit 0，且**沙箱目录树逐字节不变**。
 *   ⚠️ 同时钉住**别人的决定不许顺手改**：`import-json` **不在** `DRY_RUN_COMMANDS`、
 *      登记在 `DRY_RUN_UNSUPPORTED` —— 它按设计走裸 `store.write`，中央短路拦不住，
 *      给 `--dry-run` 只会得到"说没写、其实写了"的假报告（见 `cli/core.js` 那段注释）。
 *      所以本文件既断言清单归属，也断言 **`import-json --dry-run` 仍然响亮拒绝**。
 *
 * ## 缺陷 3 的判据（"确定性"是硬要求，不是"看起来稳定"）
 *   · `--json` 能被 `JSON.parse`，**键序固定**（字面量顺序即契约，两跑逐字节相同靠它）；
 *   · **无时间戳**（`origin.at` 不进）、**无绝对路径**（`source` 只给文件名 + 指纹）；
 *   · **无逐跑会变的字段**：节点 id（`idGen` 含时间+随机）、资源新文件名（命名含时间戳）、
 *     试过的候选路径（绝对路径）—— 这三样在 `import-md --json` 里**必须不出现**
 *     （它们的完整内容仍在文本回档里，见 `cli/commands/project.js` 的 `refReportStable`）；
 *   · **两跑逐字节相同**：`import-md` 用 `--force` 让第二次也真的执行（否则第二次会被幂等闸门拒，
 *     比的就不是"同一件事跑两遍"而是"成功 vs 拒绝"）；`import-json` 用两个不同 `--name`
 *     ⇒ 除 `project` 字段外必须逐字节相同（项目名不同，那一项本来就该不同）。
 *
 * ## 环境要点（与 tests/w8-dry-run.test.js 同口径）
 *   ① `AI_MINDMAP_PROJECTS_DIR` 必须在 require `cli/main.js` **之前**设好，并**当场自证**；
 *   ② 端到端一律**进程内** `invokeSync`（不起子进程 —— 受限环境下管道 stdio 会 EPERM 假失败）；
 *   ③ 真实 `projects/` **只读**：夹具、断言、清理全在 `SANDBOX`（临时目录）里，`afterAll` 删干净；
 *   ④ 关掉访问埋点（量的是"项目目录的字节"，不留旁路写入来源）。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);

const SANDBOX = makeTmp('mm-importfix-');   // 项目根（**唯一**会被写的地方）
const FIXDIR = makeTmp('mm-importfixfix-'); // 夹具目录（不在项目根里，免得被 projects 扫到）
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const heatSensor = require('../src/heat-sensor.js');

heatSensor.__setEnabledForTest(false);

/* 重定向必须**当场**生效：否则夹具会建进真实 projects/。宁可在这里响亮地红。 */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效：PROJECTS_DIR=' + core.PROJECTS_DIR + ' 期望=' + SANDBOX
    + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

afterAll(cleanupAll);

/** 跑一条命令（进程内同步）：返回 `{ code, out }`（stdout+stderr 合并，与集成脚本同口径） */
function run(argv) {
  const r = invokeSync(argv);
  return { code: r.code, out: (r.stdout + r.stderr) };
}
/** 只取 stdout 的那一份（`--json` 的确定性比的就是 stdout 的字节） */
function stdoutOf(argv) {
  const r = invokeSync(argv);
  return { code: r.code, out: String(r.stdout || '') };
}
function jsonOf(text) { try { return JSON.parse(text); } catch (e) { return null; } }

/** 沙箱整棵树快照（相对路径 + 内容 sha256）：判据"dry-run 一个字节都不写"的量具 */
function snapAll() {
  const rows = [];
  (function walk(d) {
    fs.readdirSync(d, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .forEach((e) => {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { walk(abs); return; }
        rows.push(path.relative(SANDBOX, abs).split(path.sep).join('/') + '|'
          + crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'));
      });
  })(SANDBOX);
  return rows.join('\n');
}

/* ---------------- 夹具 ---------------- */
const MD_FILE = path.join(FIXDIR, 'note.md');
const MD_TEXT = [
  '前导正文（第一个标题之前）：这段要落进父节点 root 的 detail，并在 `--json` 里如实报出落点。',
  '',
  '# 甲主题',
  '',
  '## 甲-1',
  '',
  '### 甲-1-1',                       // 2 级已存在 ⇒ 不补占位节点
  '',
  '![图：本地](assets/a.png)',
  '',
  '![图：远程](https://example.com/x.png)',
  '',
  '```sh',
  '# 围栏里的注释不是标题',
  'ls -l',
  '```',
  ''
].join('\n');

function seed() {
  fs.mkdirSync(path.join(FIXDIR, 'assets'), { recursive: true });
  fs.writeFileSync(MD_FILE, MD_TEXT, 'utf8');
  // 1×1 PNG（合法魔数）：让引用的 status 走到 `copy`（这条最需要"确定性"的口径）
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64');
  fs.writeFileSync(path.join(FIXDIR, 'assets', 'a.png'), png);
}
seed();

const LIB = path.join(FIXDIR, 'lib');
fs.mkdirSync(LIB, { recursive: true });
fs.writeFileSync(path.join(LIB, 'a.md'), '# 甲\n\n正文甲\n\n```sh\n# 不是标题\n```\n', 'utf8');
fs.writeFileSync(path.join(LIB, 'b.md'), '# 乙\n\n正文乙\n', 'utf8');

/* ============================================================================
 * A 组：清单归属（缺陷 2 的"核"那一半）
 * ========================================================================== */
describe('缺陷 2 · A 清单归属', () => {
  it('A1 `import-dir` 在 `WRITE_COMMANDS` 里（它 `ctx.write` 一次原子写 ⇒ 是写命令）', () => {
    expect(core.WRITE_COMMANDS).toContain('import-dir');
  });

  it('A2 `import-dir` 仍在 `DRY_RUN_COMMANDS` 里（两张清单**不冲突**：认 --dry-run 与认 --idem 是两回事）', () => {
    expect(core.DRY_RUN_COMMANDS).toContain('import-dir');
  });

  it('A3 别人的决定不动：`import-json` **不在** `DRY_RUN_COMMANDS`、仍登记在 `DRY_RUN_UNSUPPORTED`', () => {
    expect(core.DRY_RUN_COMMANDS).not.toContain('import-json');
    expect(Object.keys(core.DRY_RUN_UNSUPPORTED)).toEqual(['import-json']);
  });

  it('A4 写命令清单里的每一条都是**真在册**的命令名（范围：`WRITE_COMMANDS − 在册名单` 必须为空）', () => {
    const registry = require('../cli/registry.js');
    const names = new Set(registry.list().map((c) => c.name));
    expect(core.WRITE_COMMANDS.filter((n) => !names.has(n))).toEqual([]);
  });
});

/* ============================================================================
 * B 组：缺陷 2 的行为判据（exit 0 + 一个字节都不写）
 * ========================================================================== */
describe('缺陷 2 · B `import-dir --idem k --dry-run` 放行且零写盘', () => {
  it('B1 带 `--idem` 的 dry-run ⇒ **exit 0**（修前 exit 1：「import-dir 不写盘」）', () => {
    const before = snapAll();
    const r = run(['import-dir', 'fix-dir-idem', LIB, '--idem', 'k-fix', '--dry-run']);
    expect(r.code, '报文：' + String(r.out).slice(0, 200)).toBe(0);
    expect(r.out).not.toContain('只对**写命令**有意义');
    expect(r.out).toContain('没有写盘');
    expect(snapAll(), 'dry-run 之后沙箱必须逐字节不变').toBe(before);
    expect(fs.existsSync(path.join(SANDBOX, 'fix-dir-idem'))).toBe(false);
  });

  it('B2 对照：不带 `--idem` 的 dry-run 也是 exit 0（两个开关各自放行，互不为前提）', () => {
    const before = snapAll();
    const r = run(['import-dir', 'fix-dir-plain', LIB, '--dry-run']);
    expect(r.code).toBe(0);
    expect(snapAll()).toBe(before);
  });

  it('B3 真跑一次（沙箱里）确实会写盘 ⇒ 证明 B1/B2 的"不变"是**关掉了写**，不是"什么都没做"', () => {
    const r = run(['import-dir', 'fix-dir-real', LIB]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(SANDBOX, 'fix-dir-real', 'fix-dir-real.json'))).toBe(true);
  });
});

/* ============================================================================
 * C 组：缺陷 3 · `import-md --json`
 * ========================================================================== */
describe('缺陷 3 · C `import-md --json`（确定性 + 形状）', () => {
  const P = 'fix-md-json';

  it('C1 第一次（真跑）⇒ exit 0 且 stdout **是一份可解析 JSON**（修前只有文本回档）', () => {
    run(['init', P, '--title', '固定夹具']);
    const r = stdoutOf(['import-md', P, MD_FILE, '--json']);
    expect(r.code, r.out.slice(0, 200)).toBe(0);
    const j = jsonOf(r.out);
    expect(j, 'stdout 必须是 JSON：' + r.out.slice(0, 200)).not.toBeNull();
    expect(Object.keys(j)).toEqual(['ok', 'command', 'project', 'parent', 'nodes', 'themes', 'preamble', 'source', 'resourceRefs']);
    expect(j.ok).toBe(true);
    expect(j.command).toBe('import-md');
    expect(j.project).toBe(P);
    expect(j.parent).toBe('root');
    expect(j.nodes).toBe(3);          // 甲主题 / 甲-1 / 甲-1-1（围栏里的 `#` 不算标题）
    expect(j.source.name).toBe('note.md');
    expect(j.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(j.source.tool).toBe('import-md');
  });

  it('C2 正文头部（前导正文）的落点如实进 JSON：`preamble.landed` = detail + 字符数 > 0', () => {
    const j = jsonOf(stdoutOf(['import-md', P, MD_FILE, '--force', '--json']).out);
    expect(j.preamble.landed).toBe('detail');
    expect(j.preamble.chars).toBeGreaterThan(0);
  });

  it('C3 资源引用只报**确定性**字段：copy / remote 计数对得上，且**没有** node id / dest / tried', () => {
    const j = jsonOf(stdoutOf(['import-md', P, MD_FILE, '--force', '--json']).out);
    expect(j.resourceRefs.total).toBe(2);
    expect(j.resourceRefs.copy).toBe(1);
    expect(j.resourceRefs.remote).toBe(1);
    const refs = j.resourceRefs.refs;
    expect(refs.length).toBe(2);
    refs.forEach((r) => {
      expect(Object.keys(r)).toEqual(['topic', 'kind', 'ref', 'status']);
    });
    const text = JSON.stringify(j);
    expect(text).not.toContain('"node"');
    expect(text).not.toContain('"dest"');
    expect(text).not.toContain('"tried"');
  });

  it('C4 **两跑逐字节相同**（同一状态：第二跑带 --force 让它真的执行，而不是被幂等闸门拒掉）', () => {
    const a = stdoutOf(['import-md', P, MD_FILE, '--force', '--json']);
    const b = stdoutOf(['import-md', P, MD_FILE, '--force', '--json']);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(crypto.createHash('sha256').update(b.out).digest('hex'))
      .toBe(crypto.createHash('sha256').update(a.out).digest('hex'));
  });

  it('C5 **无绝对路径 / 无时间戳**：stdout 里不出现夹具目录、沙箱目录，也没有盘符路径', () => {
    const r = stdoutOf(['import-md', P, MD_FILE, '--force', '--json']);
    expect(r.out).not.toContain(FIXDIR);
    expect(r.out).not.toContain(SANDBOX);
    expect(r.out).not.toMatch(/(^|["\s])[A-Za-z]:[\\/]/m);
    expect(r.out).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);   // ISO 时间戳的形状
  });
});

/* ============================================================================
 * D 组：缺陷 3 · `import-json --json`
 * ========================================================================== */
describe('缺陷 3 · D `import-json --json`（确定性 + 形状）', () => {
  const SEED = 'fix-json-seed';
  const AIMAP = path.join(FIXDIR, 'pack.aimap.json');

  it('D0 前置：造一份 aimap（走产品自己的 export-json，不手写包格式）', () => {
    run(['init', SEED, '--title', '种子项目']);
    run(['add', SEED, 'root', '--topic', '甲', '--detail-md', '正文']);
    const r = run(['export-json', SEED, AIMAP]);
    expect(r.code, String(r.out).slice(0, 200)).toBe(0);
    expect(fs.existsSync(AIMAP)).toBe(true);
  });

  it('D1 import-json 第一跑 ⇒ exit 0 且 stdout 是一份可解析 JSON（修前只有一行文本）', () => {
    const r = stdoutOf(['import-json', AIMAP, '--name', 'fix-json-a', '--json']);
    expect(r.code, r.out.slice(0, 200)).toBe(0);
    const j = jsonOf(r.out);
    expect(j, 'stdout 必须是 JSON：' + r.out.slice(0, 200)).not.toBeNull();
    expect(Object.keys(j)).toEqual(['ok', 'command', 'project', 'nodes', 'images', 'files', 'assets', 'assoc', 'source']);
    expect(j.ok).toBe(true);
    expect(j.command).toBe('import-json');
    expect(j.project).toBe('fix-json-a');
    expect(j.nodes).toBeGreaterThan(0);
    expect(j.source.name).toBe('pack.aimap.json');
    expect(j.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('D2 同一份 aimap 换一个项目名再导 ⇒ 除 `project` 外**逐字节相同**（两跑确定性）', () => {
    const a = jsonOf(stdoutOf(['import-json', AIMAP, '--name', 'fix-json-b', '--json']).out);
    const b = jsonOf(stdoutOf(['import-json', AIMAP, '--name', 'fix-json-c', '--json']).out);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    delete a.project;
    delete b.project;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('D3 **无绝对路径 / 无时间戳**（`source` 只给文件名 + 指纹，不给入参路径）', () => {
    const r = stdoutOf(['import-json', AIMAP, '--name', 'fix-json-d', '--json']);
    expect(r.out).not.toContain(FIXDIR);
    expect(r.out).not.toContain(SANDBOX);
    expect(r.out).not.toMatch(/(^|["\s])[A-Za-z]:[\\/]/m);
    expect(r.out).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('D4 别人的决定不动：`import-json --dry-run` 仍然**响亮拒绝**并说清为什么（不许给它开绿灯）', () => {
    const r = run(['import-json', AIMAP, '--name', 'fix-json-e', '--dry-run']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('--dry-run 对 import-json **不可用**');
    expect(fs.existsSync(path.join(SANDBOX, 'fix-json-e'))).toBe(false);
  });
});
