/* ============================================================
 * tests/diagram-profile-shapes.test.js —— **§4.2 取值收窄（六种形状）**
 * ------------------------------------------------------------
 * 设计原文（`docs/DIAGRAM-MODES.md` §4.2）：`logic` 只给 `rect` / `round` / `diamond`，
 * 其余三型不给。这一条是"**取值收窄**"，不是"关能力"（`C-F1-01` 在 `logic` 列仍是 ✓）。
 *
 * 本文件要钉住的四件事（每件都能单独判红）：
 *   ① **规则的真源在文档**：本文件**解析** `docs/DIAGRAM-MODES.md` §4.2 那一行，把它里面的形状
 *      清单与 `D.shapesForProfile('logic')` **逐字对拍** —— 代码与设计稿漂了就是红；
 *   ② **该绿**：`logic` 下只用允许的形状 ⇒ 正常渲染、零降级；
 *   ③ **该红**（不许静默接受）：`logic` 下用不允许的形状 ⇒ **要么**按规则降级且报告逐条点名，
 *      **要么**（`shapePolicy: 'reject'`）抛 `E_PROFILE_SHAPE` + 允许集 + 可用修法；
 *   ④ **基线不动**：不带 `graph.profile` 的输入 ⇒ 产物与 `render-svg.renderDiagram` 直出**逐字节相同**。
 *
 * 判据**独立复算**：形状一律从产出的 SVG 里读（`readNodes`），不读 `report.profileShapes` 来自证；
 * 报告只用来"两边比一比"。
 * ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';

import D from '../src/diagram/index.js';
import * as raw from '../src/diagram/render-svg.js';
import * as profiles from '../src/diagram/profiles.js';
import { readNodes } from './diagram-svg-reader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = readFileSync(join(HERE, '..', 'docs', 'DIAGRAM-MODES.md'), 'utf8');

/* ------------------------------------------------------------------
 * ① 文档是规则的真源：从 §4.2 那一行解析 `logic` 的允许形状
 * ------------------------------------------------------------------ */
function docLogicShapes() {
  const sec = DOC.indexOf('### 4.2');
  expect(sec, 'docs/DIAGRAM-MODES.md 里找不到 §4.2（文档结构变了？这条判据要跟着改）').toBeGreaterThan(0);
  const end = DOC.indexOf('\n### 4.3', sec);
  const block = DOC.slice(sec, end > 0 ? end : DOC.length);
  const row = block.split('\n').find((l) => l.indexOf('`C-F1-01`') >= 0);
  expect(row, '§4.2 里找不到 `C-F1-01` 那一行（六形状的取值收窄是这一行的责任）').toBeTruthy();
  const out = [];
  const re = /`(rect|round|diamond|pill|cylinder|row)`/g;
  let m;
  while ((m = re.exec(row))) out.push(m[1]);
  return out;
}

/* ------------------------------------------------------------------
 * 夹具：六种形状各一个（故意做成"全都不在 logic 允许集里"的极端）
 * ------------------------------------------------------------------ */
const ALL = ['rect', 'round', 'diamond', 'pill', 'cylinder', 'row'];

function shapeDoc(profile, types) {
  const nodes = types.map((t, i) => ({ id: 'n-' + i, type: t, title: '节点 ' + (i + 1) }));
  const edges = [];
  for (let i = 1; i < nodes.length; i++) {
    edges.push({ id: 'e' + i, from: { node: 'n-' + (i - 1) }, to: { node: 'n-' + i } });
  }
  const graph = { version: 1, direction: 'LR', edges: edges };
  if (profile !== null) graph.profile = profile;
  return { graph: graph, nodes: nodes };
}

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('§4.2 六形状：剖面 → 允许形状表（与设计稿逐字对拍）', () => {
  it('`logic` 的允许集 === 文档 §4.2 那一行里的形状清单', () => {
    const fromDoc = docLogicShapes();
    expect(fromDoc.length, '§4.2 那一行里没解析出形状名（文档改法会让这条判据空转）').toBeGreaterThan(0);
    expect(D.shapesForProfile('logic')).toEqual(fromDoc);
  });

  it('形状表的键集 === 五个剖面；每格都在六型的全集里，且 `complex`/`module` 六型全给', () => {
    expect(Object.keys(D.PROFILE_SHAPES).sort()).toEqual(profiles.PROFILES.slice().sort());
    Object.keys(D.PROFILE_SHAPES).forEach((p) => {
      D.PROFILE_SHAPES[p].forEach((t) => expect(ALL).toContain(t));
    });
    expect(D.shapesForProfile('complex').sort()).toEqual(ALL.slice().sort());
    expect(D.shapesForProfile('module').sort()).toEqual(ALL.slice().sort());
  });

  it('`mindmap` / `path` 的形状允许集是**空**（这两档把 `C-F1-01` 判 ✗）', () => {
    expect(D.shapesForProfile('mindmap')).toEqual([]);
    expect(D.shapesForProfile('path')).toEqual([]);
    // 与能力矩阵同源：这两档在 §3.2 里 `C-F1-01` 就是 ✗
    expect(D.profileMark('mindmap', 'C-F1-01')).toBe(profiles.REJECTED);
    expect(D.profileMark('path', 'C-F1-01')).toBe(profiles.REJECTED);
  });

  it('未知剖面 ⇒ 响亮拒绝（`E_PROFILE_UNKNOWN`），不静默当全开', () => {
    expect(() => D.shapesForProfile('nope')).toThrow(/未知剖面/);
  });
});

describe('§4.2 该绿：`logic` 下只用允许的形状 ⇒ 正常渲染、零降级', () => {
  const doc = shapeDoc('logic', ['rect', 'round', 'diamond', 'rect']);

  it('渲染成功，且报告里 narrowed 为空、degraded 里没有形状降级', () => {
    const res = D.renderAuto(doc);
    expect(res.svg.length).toBeGreaterThan(0);
    expect(res.report.profileShapes.profile).toBe('logic');
    expect(res.report.profileShapes.allowed).toEqual(['rect', 'round', 'diamond']);
    expect(res.report.profileShapes.narrowed).toEqual([]);
    expect(res.report.degraded.filter((d) => d.indexOf('W_SHAPE_NARROWED') >= 0)).toEqual([]);
  });

  it('从 SVG 读出的形状**逐节点等于数据里的形状**（没被悄悄换掉）', () => {
    const res = D.renderAuto(doc);
    const got = readNodes(res.svg).map((n) => n.shape).sort();
    const want = doc.nodes.map((n) => n.type).sort();
    expect(got).toEqual(want);
  });

  it('`complex` / `module` 六型全给 ⇒ 一个都不降级（收窄只发生在 `logic`）', () => {
    ['complex', 'module'].forEach((p) => {
      const res = D.renderAuto(shapeDoc(p, ALL));
      expect(res.report.profileShapes.narrowed, p + ' 不该收窄').toEqual([]);
      expect(readNodes(res.svg).map((n) => n.shape).sort()).toEqual(ALL.slice().sort());
    });
  });
});

describe('§4.2 该红：`logic` 下用不允许的形状 ⇒ **不许静默接受**', () => {
  const BAD = shapeDoc('logic', ['cylinder', 'row', 'pill', 'rect']);

  it('**缺省档 = degrade**：逐节点点名"从什么换成什么"，且 SVG 里真的换了形状', () => {
    const res = D.renderAuto(BAD);                       // 不传 shapePolicy ⇒ 走缺省
    expect(res.report.profileShapes.policy).toBe('degrade');
    const narrowed = res.report.profileShapes.narrowed;
    expect(narrowed.length).toBe(3);
    expect(narrowed.map((x) => x.id).sort()).toEqual(['n-0', 'n-1', 'n-2']);
    // 逐条点名：映射是 §4.2 表里写清的那三个（cylinder→round / row→rect / pill→round）
    expect(narrowed.find((x) => x.from === 'cylinder').to).toBe('round');
    expect(narrowed.find((x) => x.from === 'row').to).toBe('rect');
    expect(narrowed.find((x) => x.from === 'pill').to).toBe('round');
    // 报告里**逐条**有降级条目（不是只给个计数）
    const degr = res.report.degraded.filter((d) => d.indexOf('W_SHAPE_NARROWED') >= 0);
    expect(degr.length).toBe(3);
    narrowed.forEach((x) => {
      expect(degr.some((d) => d.indexOf('节点 ' + x.id + ' ') >= 0)).toBe(true);
    });
    // 独立读数：SVG 里不再有 cylinder / row / pill
    const shapes = readNodes(res.svg).map((n) => n.shape);
    expect(shapes.indexOf('cylinder')).toBe(-1);
    expect(shapes.indexOf('row')).toBe(-1);
    expect(shapes.indexOf('pill')).toBe(-1);
    // 而且**换了形状的那三个节点**读出来就是映射后的型
    const byId = new Map(readNodes(res.svg).map((n) => [n.id, n.shape]));
    narrowed.forEach((x) => expect(byId.get(x.id)).toBe(x.to));
  });

  it('严格档（reject）：抛 `E_PROFILE_SHAPE`，带允许集与可用修法（稳定码，不靠文案）', () => {
    let err = null;
    try { D.renderAuto(BAD, { shapePolicy: 'reject' }); } catch (e) { err = e; }
    expect(err, 'reject 档必须抛错（静默画出来就是"静默接受不允许的形状"）').toBeTruthy();
    expect(err.code).toBe('E_PROFILE_SHAPE');
    expect(err.detail.allowed).toEqual(['rect', 'round', 'diamond']);
    expect(Array.isArray(err.detail.fixes)).toBe(true);
    expect(err.detail.fixes.length).toBeGreaterThan(0);
    expect(err.detail.object.profile).toBe('logic');
    expect(err.detail.object.type).toBe('cylinder');       // 第一个越界的那个（此处是 n-0）
  });

  it('`shapePolicy` 取值非法 ⇒ `E_SHAPE_POLICY`（未知处置不静默当降级）', () => {
    let err = null;
    try { D.renderAuto(BAD, { shapePolicy: 'warn' }); } catch (e) { err = e; }
    expect(err && err.code).toBe('E_SHAPE_POLICY');
    expect(err.detail.allowed).toEqual(['report', 'degrade', 'reject']);
  });

  it('`report` 档（保留，不是缺省）：画法不动，但每个越界节点逐条登记', () => {
    const res = D.renderAuto(BAD, { shapePolicy: 'report' });
    expect(res.report.profileShapes.policy).toBe('report');
    expect(res.report.profileShapes.outOfProfile.map((x) => x.id).sort()).toEqual(['n-0', 'n-1', 'n-2']);
    expect(res.report.profileShapes.narrowed).toEqual([]);          // 没换画法
    const degr = res.report.degraded.filter((d) => d.indexOf('W_SHAPE_OUT_OF_PROFILE') >= 0);
    expect(degr.length).toBe(3);
    // 独立读数：SVG 里**仍有** cylinder / row / pill（画法没动）
    const shapes = readNodes(res.svg).map((n) => n.shape);
    expect(shapes.indexOf('cylinder')).toBeGreaterThanOrEqual(0);
    expect(shapes.indexOf('row')).toBeGreaterThanOrEqual(0);
    expect(shapes.indexOf('pill')).toBeGreaterThanOrEqual(0);
  });

  it('`report` 档**逐条**给 `outOfProfile`（不是只数个数），且三种档位都还在', () => {
    const res = D.renderAuto(BAD, { shapePolicy: 'report' });
    const ids = res.report.profileShapes.outOfProfile.map((x) => x.id).sort();
    expect(ids).toEqual(['n-0', 'n-1', 'n-2']);
    res.report.profileShapes.outOfProfile.forEach((x) => {
      expect(x.allowed).toEqual(['rect', 'round', 'diamond']);
      expect(x.from).not.toBe('rect');
    });
    expect(D.SHAPE_POLICIES).toEqual(['report', 'degrade', 'reject']);   // 三档都不许删
  });

  it('`mindmap` / `path` 遇到任何形状 ⇒ **两种档位都拒绝**（那不是收窄，是"没有形状能力"）', () => {
    ['mindmap', 'path'].forEach((p) => {
      ['report', 'degrade', 'reject'].forEach((policy) => {
        let err = null;
        try { D.renderAuto(shapeDoc(p, ['rect']), { shapePolicy: policy }); } catch (e) { err = e; }
        expect(err, p + '/' + policy + ' 必须拒绝').toBeTruthy();
        expect(err.code).toBe('E_PROFILE_SHAPE');
        expect(err.detail.allowed).toEqual([]);
      });
    });
  });

  it('"手写坐标"入口（`render`）与自动布局入口（`renderAuto`）**同一套处置**', () => {
    const doc = shapeDoc('logic', ['cylinder', 'rect']);
    const byDefault = D.render({ graph: { version: 1, profile: 'logic' }, nodes: [
      { id: 'n-0', type: 'cylinder', title: '根', rect: [0, 0, 160, 64] },
      { id: 'n-1', type: 'rect', title: '环节', rect: [240, 0, 160, 64] }
    ] });
    // 缺省档（degrade）：换画法 —— 两个入口同一套
    expect(byDefault.report.profileShapes.policy).toBe('degrade');
    expect(byDefault.report.profileShapes.narrowed).toEqual([{ id: 'n-0', from: 'cylinder', to: 'round' }]);
    expect(byDefault.report.profileShapes.outOfProfile).toEqual([]);
    const reported = D.render({ graph: { version: 1, profile: 'logic' }, nodes: [
      { id: 'n-0', type: 'cylinder', title: '根', rect: [0, 0, 160, 64] },
      { id: 'n-1', type: 'rect', title: '环节', rect: [240, 0, 160, 64] }
    ] }, { shapePolicy: 'report' });
    expect(reported.report.profileShapes.narrowed).toEqual([]);
    expect(reported.report.profileShapes.outOfProfile).toEqual([
      { id: 'n-0', from: 'cylinder', allowed: ['rect', 'round', 'diamond'] }]);
    let err = null;
    try {
      D.render({ graph: { version: 1, profile: 'logic' }, nodes: [
        { id: 'n-0', type: 'cylinder', title: '根', rect: [0, 0, 160, 64] }
      ] }, { shapePolicy: 'reject' });
    } catch (e) { err = e; }
    expect(err && err.code).toBe('E_PROFILE_SHAPE');
    expect(doc.nodes[0].type).toBe('cylinder');            // 输入没被改（渲染不许碰数据）
  });
});

describe('§4.2 的边界：不带 profile 就**一个字节都不动**（MS1/MS2 基线）', () => {
  it('`render()` 与 `render-svg.renderDiagram()` 直出逐字节相同', () => {
    const legacy = { graph: { version: 1 }, nodes: [
      { id: 'x', rect: [10, 10, 100, 40], type: 'rect', title: 'hi' },
      { id: 'y', rect: [200, 10, 100, 40], type: 'diamond', title: 'q' }
    ], };
    legacy.graph.edges = [{ id: 'e1', from: { node: 'x' }, to: { node: 'y' }, route: 'straight' }];
    const viaWrapper = D.render(legacy);
    const direct = raw.renderDiagram(legacy);
    expect(sha(viaWrapper.svg)).toBe(sha(direct.svg));
    expect(viaWrapper.report.profileShapes.profile).toBe(null);
    expect(viaWrapper.report.profileShapes.narrowed).toEqual([]);
    // 报告也没多出降级条目（`profileShapes` 是新增键，`degraded` 不多一条）
    expect(viaWrapper.report.degraded).toEqual(direct.report.degraded);
  });

  it('`renderAuto()`：不带 profile ⇒ 两个节点形状都留着（六型全画）', () => {
    const res = D.renderAuto(shapeDoc(null, ['cylinder', 'row']));
    expect(res.report.profileShapes.profile).toBe(null);
    expect(readNodes(res.svg).map((n) => n.shape).sort()).toEqual(['cylinder', 'row']);
  });
});
