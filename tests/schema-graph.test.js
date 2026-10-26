/* ============================================================
 * tests/schema-graph.test.js —— `validate` **认识 `graph`** + 未知键**不再静默**
 * ------------------------------------------------------------
 * 本批前置缺陷 ①（实测读数：干净项目 exit 0 → 顶层加 `graph` 仍 0 → 节点加 `rect` 仍 0）：
 *   ⇒ 【"校验通过"不能证明"字段被支持"】。
 * 本文件的判据分三档（与 `src/schema.js` 的 `PROJECT_TOP_LEVEL_FIELDS` 注释逐条对应）：
 *   · `graph` 被认识（形状对 ⇒ ok；形状错/引用悬挂 ⇒ 判红并点名）；
 *   · 顶层与节点上的**未知键 ⇒ 警告**（`ok` 不变，但 `--json` 的 `warnings[]` 里看得见）；
 *   · `graph` 内部的**未知键 ⇒ 错误**（新造的一层、零存量数据 ⇒ 判红零成本）。
 * 还有一条"数据不会丢"：CLI 的定点写命令（`edit`）走完之后，盘上 `graph` **逐字节仍在**。
 * ============================================================ */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);

/* ---- 沙箱：`AI_MINDMAP_PROJECTS_DIR` 必须在 require CLI **之前**指到临时目录 ---- */
const SANDBOX = makeTmp('mm-diagram-graph-');
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;
process.env.MM_HEAT_SENSOR = 'off';

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const S = require('../src/schema.js');

if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效：PROJECTS_DIR=' + core.PROJECTS_DIR + ' 期望=' + SANDBOX
    + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

afterAll(cleanupAll);

const PROJ = 'diagram-graph';
const FILE = () => path.join(SANDBOX, PROJ, PROJ + '.json');
const run = (...argv) => invokeSync(argv);
const readDisk = () => JSON.parse(fs.readFileSync(FILE(), 'utf8'));
const writeDisk = (data) => fs.writeFileSync(FILE(), JSON.stringify(data, null, 2), 'utf8');

/** 一次建好夹具：一个干净项目，再加两条边引用的节点 */
beforeAll(() => {
  const steps = [
    ['init', PROJ, '--title', '图附加层样本'],
    ['add', PROJ, 'root', '--id', 'n-a', '--topic', '甲节点'],
    ['add', PROJ, 'root', '--id', 'n-b', '--topic', '乙节点']
  ];
  steps.forEach((argv) => {
    const r = run(...argv);
    if (r.code !== 0) throw new Error('夹具建不起来（' + argv.join(' ') + '）：' + r.stdout + r.stderr);
  });
});

/** **干净的基线项目**（每个用例都从它出发 —— 否则前一个用例故意写坏的键会污染后一个用例） */
function cleanData() {
  return {
    meta: { name: PROJ, formatVersion: 3 },
    format: 'node_tree',
    data: {
      id: 'root', topic: '图附加层样本', expanded: true,
      children: [
        { id: 'n-a', topic: '甲节点', expanded: true, children: [] },
        { id: 'n-b', topic: '乙节点', expanded: true, children: [] }
      ]
    }
  };
}

/** 每次用一份干净的"带 graph 的项目"（避免用例互相污染） */
function withGraph(extra) {
  const data = cleanData();
  data.graph = Object.assign({
    version: 1,
    profile: 'complex',
    direction: 'LR',
    grid: 8,
    layers: [{ id: 'l-core', label: 'Core', labelSide: 'top', rect: [0, 0, 600, 300], fill: '#eef4fb' }],
    containers: [{ id: 'c-box', label: '盒子', rect: [10, 10, 200, 80], layout: 'stack', children: ['n-a'] }],
    edges: [{ id: 'e-ab', from: { node: 'n-a', port: 'e' }, to: { node: 'n-b', port: 'w' }, route: 'straight' }],
    annotations: [{ text: '一句注释', at: [12, 40] }],
    pinned: ['n-a']
  }, extra || {});
  writeDisk(data);
  return data;
}

describe('`graph` 被 validate 认识（缺陷 ① 的正向判据）', () => {
  it('带 graph 的项目：validate 通过（exit 0），且 graph 一个字节没被动过', () => {
    const before = withGraph().graph;
    const r = run('validate', PROJ);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('校验通过');
    // **校验是纯的**：跑完盘上那份 graph 仍在、且序列化逐字节相同
    expect(JSON.stringify(readDisk().graph)).toBe(JSON.stringify(before));
  });

  it('`validate --json` 报 ok:true 且带 warnings 键（空数组也算有这一档）', () => {
    withGraph();
    const r = run('validate', PROJ, '--json');
    const v = JSON.parse(r.stdout);
    expect(r.code).toBe(0);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  it('graph 不被当成"未知键"：warnings 里**不许**出现 graph 这个词', () => {
    withGraph();
    const v = JSON.parse(run('validate', PROJ, '--json').stdout);
    expect(v.warnings.join('\n')).not.toMatch(/graph/);
  });

  it('CLI 定点写命令（edit）之后，盘上 graph **逐字节仍在**', () => {
    const before = withGraph().graph;
    const r = run('edit', PROJ, 'n-a', '--topic', '甲节点（改过）');
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const after = readDisk();
    expect(after.data.children.find((c) => c.id === 'n-a').topic).toBe('甲节点（改过）');
    expect(JSON.stringify(after.graph)).toBe(JSON.stringify(before));
  });
});

describe('graph 形状错 / 引用悬挂 ⇒ 判红（判别力：删一个被引用的节点必须红）', () => {
  it('graph 内部未知字段 ⇒ exit 非 0 并点名', () => {
    const data = withGraph();
    data.graph.crossings = 2;
    writeDisk(data);
    const r = run('validate', PROJ, '--json');
    const v = JSON.parse(r.stdout);
    expect(v.ok).toBe(false);
    expect(r.code).not.toBe(0);
    expect(v.errors.join('\n')).toContain('crossings');
  });

  it('边指向不存在的节点 ⇒ 判红并点名那条边', () => {
    const data = withGraph();
    data.graph.edges[0].to.node = 'n-gone';
    writeDisk(data);
    const v = JSON.parse(run('validate', PROJ, '--json').stdout);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toContain('edges[0].to.node');
  });

  it('**删掉被 graph 引用的节点** ⇒ 判红（这一条是本批"数据不会悬空"的判别力证明）', () => {
    const data = withGraph();
    data.data.children = data.data.children.filter((c) => c.id !== 'n-b');
    writeDisk(data);
    const r = run('validate', PROJ, '--json');
    const v = JSON.parse(r.stdout);
    expect(v.ok).toBe(false);
    expect(r.code).not.toBe(0);
    expect(v.errors.join('\n')).toContain('n-b');
  });
});

describe('未知键不再静默：顶层 / 节点 ⇒ 警告（ok 不变，但两条腿都看得见）', () => {
  it('顶层多一个键 ⇒ ok 仍 true，但 warnings 点名它（文本模式也能看见）', () => {
    const data = cleanData();
    data.weirdTop = { any: 1 };
    writeDisk(data);
    const text = run('validate', PROJ);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('校验通过');
    expect(text.stdout).toContain('⚠ 警告:');
    expect(text.stdout).toContain('weirdTop');
    const v = JSON.parse(run('validate', PROJ, '--json').stdout);
    expect(v.ok).toBe(true);
    expect(v.warnings.length).toBe(1);
    expect(v.warnings[0]).toContain('weirdTop');
  });

  it('节点上多一个字段 ⇒ ok 仍 true，但 warnings 点名它（**"校验通过"不再等于"字段被支持"**）', () => {
    const data = cleanData();
    data.data.children[0].rect = [0, 0, 100, 40];     // 正是沙箱实测过的那一个键
    writeDisk(data);
    const r = run('validate', PROJ, '--json');
    const v = JSON.parse(r.stdout);
    expect(r.code).toBe(0);
    expect(v.ok).toBe(true);
    expect(v.warnings.join('\n')).toContain('"rect"');
    expect(v.warnings.join('\n')).toContain('n-a');   // 点名首次出现的节点
  });

  it('同一种未知字段只报一次（按字段名，不按节点数刷屏），且按字典序', () => {
    const data = cleanData();
    data.data.children.forEach((c) => { c.zzz = 1; c.aaa = 2; });
    writeDisk(data);
    const v = JSON.parse(run('validate', PROJ, '--json').stdout);
    const ws = v.warnings.filter((w) => /未知字段/.test(w));
    expect(ws.length).toBe(2);                       // aaa / zzz 各一条，不是 2 节点 × 2 字段
    expect(ws[0].indexOf('"aaa"')).toBeGreaterThan(-1);
    expect(ws[1].indexOf('"zzz"')).toBeGreaterThan(-1);
  });

  it('干净的 graph 项目**不产生**警告（警告不是噪声）', () => {
    withGraph();
    const v = JSON.parse(run('validate', PROJ, '--json').stdout);
    expect(v.warnings).toEqual([]);
  });
});

describe('API 层（不经过 CLI）的三档读数', () => {
  const doc = (mut) => {
    const d = {
      meta: { name: 'p', formatVersion: 3 },
      format: 'node_tree',
      data: { id: 'root', topic: 'R', expanded: true, children: [
        { id: 'n-a', topic: 'A', expanded: true, children: [] }
      ] }
    };
    if (mut) mut(d);
    return d;
  };

  it('validateInPlace 恒返回 warnings 数组（第三档可判，不是"有时候有"）', () => {
    expect(S.validateInPlace(doc()).warnings).toEqual([]);
    expect(S.validateInPlace(doc((d) => { d.graph = { version: 1 }; })).warnings).toEqual([]);
    expect(S.validateInPlace(doc((d) => { d.oops = 1; })).warnings.length).toBe(1);
  });

  it('顶层键表是唯一真源：`graph` 在册，未知键不在册', () => {
    expect(S.PROJECT_TOP_LEVEL_NAMES).toEqual(['meta', 'format', 'data', 'assoc', 'bindings', 'graph']);
    expect(S.PROJECT_TOP_LEVEL_NAMES).toContain('graph');
  });

  it('graph 是可选键：缺省 ⇒ 老项目零迁移、formatVersion 不升', () => {
    const d = doc();
    expect(d.meta.formatVersion).toBe(3);
    expect(S.validateProject(d).ok).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(d, 'graph')).toBe(false);
  });
});
