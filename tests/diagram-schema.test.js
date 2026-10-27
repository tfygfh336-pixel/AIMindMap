/* ============================================================
 * tests/diagram-schema.test.js —— `graph` 形状契约的**判据**（纯函数，不读盘）
 * ------------------------------------------------------------
 * 这一层是本批前置缺陷 ① 的另一半：`validate` 认识 `graph` 之前，先得有人定义"`graph` 长什么样"。
 * 判据口径（与 `src/diagram/schema.js` 文件头的两条口径**逐条**对应）：
 *   · 形状错 / 值不在档位 / 条数超限 / id 重复 ⇒ **错误**；
 *   · `graph` 内部的未知字段 ⇒ **错误**（新造的层、零存量数据 ⇒ 判红零成本；
 *     而它的坏形态正是"写了个没人渲染的键"）；
 *   · 引用悬挂（`edges[].from.node` 等指向不存在的节点）由 `validateGraphRefs` 判红（设计 §6.3）。
 * 判别力：`.review/20261056-MS1渲染内核/inject-red.js` 有一条"把 graph 当未知键丢掉"的注入，
 * 跑本文件与 `schema-graph.test.js` 必须红。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import GS from '../src/diagram/schema.js';
import S from '../src/schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 一份最小的合法 graph（每个用例只改一处，判据才可归因） */
function okGraph() {
  return {
    version: 1,
    profile: 'complex',
    direction: 'LR',
    grid: 8,
    layers: [
      { id: 'l-a', label: 'A', labelSide: 'top', rect: [0, 0, 400, 200], fill: '#eef',
        watermark: { text: 'A', rotate: -90, opacity: 0.3 } }
    ],
    containers: [
      { id: 'c-a', label: '盒子', rect: [10, 10, 200, 80], layout: 'stack', children: ['n-a'], padding: 12, gap: 8 }
    ],
    edges: [
      { id: 'e-a', from: { node: 'n-a', port: 'e' }, to: { node: 'n-b', port: 'w' },
        route: 'straight', style: 'dashed', color: 'blue', arrow: { start: true, end: true }, label: '走' }
    ],
    annotations: [{ id: 'a-1', text: '注', at: [10, 20], style: 'note' }],
    pinned: ['n-a']
  };
}

describe('取值表是唯一的一处（文档与测试从这里取，别抄字面量）', () => {
  it('六形状 / 四端口 / 三路由 / 三线型 / 两方向 / 五剖面', () => {
    expect(GS.SHAPES).toEqual(['rect', 'round', 'diamond', 'pill', 'cylinder', 'row']);
    expect(GS.PORTS).toEqual(['n', 'e', 's', 'w']);
    expect(GS.EDGE_ROUTES).toEqual(['straight', 'orthogonal', 'curve']);
    expect(GS.ROUTE_IMPLEMENTED).toEqual(['straight', 'orthogonal', 'curve']);   // MS2 补正交、2026-10-26 补曲线
    expect(GS.EDGE_STYLES).toEqual(['solid', 'dashed', 'dotted']);
    expect(GS.DASH_TOKEN).toEqual({ solid: '', dashed: '5 4', dotted: '1 3' });
    expect(GS.DIRECTIONS).toEqual(['LR', 'TB']);
    expect(GS.PROFILES).toEqual(['complex', 'mindmap', 'path', 'logic', 'module']);
    expect(GS.GRAPH_VERSION).toBe(1);
  });

  it('graph 的字段名表与设计 §6.3 草案 + MS2 的 `gap` 对齐（顶层十项）', () => {
    expect(GS.GRAPH_FIELDS).toEqual(['version', 'profile', 'direction', 'grid', 'gap',
      'layers', 'containers', 'edges', 'annotations', 'pinned']);
    expect(GS.GAP_FIELDS).toEqual(['node', 'rank']);
  });

  it('ID_RE 与 `src/schema.js` 的**逐字相同**（两处各写一份就会让同一 id 在节点上合法、在边上非法）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'schema.js'), 'utf8');
    const m = src.match(/const ID_RE = (\/[^\n]+\/);/);
    expect(m, 'src/schema.js 里找不到 ID_RE 那一行（锚点变了 ⇒ 判据失效，必须修）').toBeTruthy();
    // eslint-disable-next-line no-new-func
    const re = new Function('return ' + m[1])();
    expect(String(GS.ID_RE)).toBe(String(re));
  });
});

describe('validateGraph：合法形状通过', () => {
  it('完整的一份 graph ⇒ ok', () => {
    const v = GS.validateGraph(okGraph());
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('空对象与只写几项都合法（全字段可选，缺省值由渲染层定）', () => {
    expect(GS.validateGraph({}).ok).toBe(true);
    expect(GS.validateGraph({ direction: 'TB' }).ok).toBe(true);
  });

  it('不是对象 / null / 数组 ⇒ 判红（缺省 = 无附加结构，不写 null）', () => {
    [null, [], 'x', 3].forEach((v) => {
      const r = GS.validateGraph(v);
      expect(r.ok, JSON.stringify(v)).toBe(false);
      expect(r.errors[0]).toContain('graph 必须是对象');
    });
  });
});

describe('validateGraph：`graph` 内部未知字段 ⇒ **错误**（不是警告）', () => {
  it('顶层多一个键 ⇒ 点名它，并列出合法取值', () => {
    const g = okGraph();
    g.crossings = 3;
    const v = GS.validateGraph(g);
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toContain('"crossings"');
    expect(v.errors[0]).toContain('version');
    expect(v.errors[0]).toContain('pinned');
  });

  it('未知键按字典序报（对象键序不稳定 ⇒ 报文不许随插入序漂）', () => {
    const g1 = okGraph();
    g1.zzz = 1;
    g1.aaa = 2;
    const e1 = GS.validateGraph(g1).errors.filter((e) => /未知字段/.test(e)).join('|');
    const g2 = okGraph();
    g2.aaa = 2;
    g2.zzz = 1;
    const e2 = GS.validateGraph(g2).errors.filter((e) => /未知字段/.test(e)).join('|');
    expect(e1).toBe(e2);
    expect(e1.indexOf('"aaa"')).toBeLessThan(e1.indexOf('"zzz"'));
  });

  it('层带 / 水印 / 容器 / 边 / 端点 / 箭头 / 注释 里多一个键都报', () => {
    const cases = [
      [(g) => { g.layers[0].opacity = 0.5; }, 'layers[0]'],
      [(g) => { g.layers[0].watermark.angle = 30; }, 'watermark'],
      [(g) => { g.containers[0].direction = 'TB'; }, 'containers[0]'],
      [(g) => { g.edges[0].crossing = 'overpass'; }, 'edges[0]'],
      [(g) => { g.edges[0].from.point = [1, 2]; }, 'from'],
      [(g) => { g.edges[0].arrow.both = true; }, 'arrow'],
      [(g) => { g.annotations[0].color = 'red'; }, 'annotations[0]']
    ];
    cases.forEach(([mut, where]) => {
      const g = okGraph();
      mut(g);
      const v = GS.validateGraph(g);
      expect(v.ok, where).toBe(false);
      expect(v.errors.join('\n')).toContain(where);
      expect(v.errors.join('\n')).toContain('未知字段');
    });
  });

  it('边上的 `crossing` 被点名"属 MS2、本批没有实现"（不许静默透传）', () => {
    const g = okGraph();
    g.edges[0].crossing = 'overpass';
    const msg = GS.validateGraph(g).errors.join('\n');
    expect(msg).toContain('crossing');
    expect(msg).toMatch(/MS2|没有实现/);
  });
});

describe('validateGraph：值与形状的逐档判据', () => {
  const bad = (mut, re) => {
    const g = okGraph();
    mut(g);
    const v = GS.validateGraph(g);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toMatch(re);
  };

  it('version / profile / direction / grid', () => {
    bad((g) => { g.version = 2; }, /graph\.version/);
    bad((g) => { g.profile = 'unknown'; }, /graph\.profile/);
    bad((g) => { g.direction = 'RL'; }, /graph\.direction/);
    bad((g) => { g.grid = 0; }, /graph\.grid/);
    bad((g) => { g.grid = '8'; }, /graph\.grid/);
  });

  it('rect 必须是四个有限数字，层带/容器的宽高必须 > 0', () => {
    bad((g) => { g.layers[0].rect = [0, 0, 400]; }, /graph\.layers\[0\]\.rect/);
    bad((g) => { g.layers[0].rect = [0, 0, 0, 100]; }, /必须 > 0/);
    bad((g) => { g.containers[0].rect = [0, 0, 200, 'x']; }, /containers\[0\]\.rect/);
    bad((g) => { g.layers[0].rect = [0, 0, 1e9, 100]; }, /超出允许范围/);
  });

  it('层带 labelSide 与 fill', () => {
    bad((g) => { g.layers[0].labelSide = 'bottom'; }, /labelSide/);
    bad((g) => { g.layers[0].fill = ''; }, /fill/);
  });

  it('水印 opacity 必须在 0–1（1 就不是水印了），rotate 在 ±360 内', () => {
    bad((g) => { g.layers[0].watermark.opacity = 1.5; }, /opacity/);
    bad((g) => { g.layers[0].watermark.rotate = 999; }, /rotate/);
    bad((g) => { g.layers[0].watermark.text = ''; }, /text/);
  });

  it('容器 layout 必填且只有 stack/free；children 必须非空且不重复', () => {
    bad((g) => { delete g.containers[0].layout; }, /layout 必填/);
    bad((g) => { g.containers[0].layout = 'grid'; }, /stack|free/);
    bad((g) => { g.containers[0].children = []; }, /children/);
    bad((g) => { g.containers[0].children = ['n-a', 'n-a']; }, /重复/);
    bad((g) => { g.containers[0].padding = -1; }, /padding/);
    bad((g) => { g.containers[0].gap = 9999; }, /gap/);
  });

  it('边的 route 取值在档内（orthogonal/curve 是**合法取值**，只是本批渲染不出来）', () => {
    ['straight', 'orthogonal', 'curve'].forEach((r) => {
      const g = okGraph();
      g.edges[0].route = r;
      expect(GS.validateGraph(g).ok, r).toBe(true);     // 形状合法 —— 拒绝发生在渲染，不在校验
    });
    bad((g) => { g.edges[0].route = 'bezier'; }, /route/);
  });

  it('边 style / arrow 两端独立（布尔）/ 端口取值', () => {
    bad((g) => { g.edges[0].style = 'wavy'; }, /style/);
    bad((g) => { g.edges[0].arrow.start = 'yes'; }, /arrow\.start/);
    bad((g) => { g.edges[0].from.port = 'top'; }, /port/);
    bad((g) => { g.edges[0].color = ''; }, /color/);
  });

  it('注释的 at 必须是两个有限数字', () => {
    bad((g) => { g.annotations[0].at = [1]; }, /\.at/);
    bad((g) => { g.annotations[0].at = ['a', 2]; }, /\.at/);
    bad((g) => { g.annotations[0].text = ''; }, /text/);
  });

  it('id 规范与重复（层带 / 容器 / 边各自唯一）', () => {
    bad((g) => { g.layers[0].id = 'L A'; }, /非法字符/);
    bad((g) => { g.edges.push(Object.assign({}, g.edges[0])); }, /id 重复/);
    bad((g) => { g.containers.push(Object.assign({}, g.containers[0])); }, /id 重复/);
    bad((g) => { g.layers.push(Object.assign({}, g.layers[0])); }, /id 重复/);
  });

  it('pinned 是集合语义：重复 ⇒ 判红', () => {
    bad((g) => { g.pinned = ['n-a', 'n-a']; }, /重复/);
  });

  it('条数上限：超限**响亮**说出来（不静默截断）', () => {
    const g = okGraph();
    g.layerTooMany = undefined;
    g.layers = [];
    for (let i = 0; i < GS.LIMITS.items.layers + 1; i++) {
      g.layers.push({ id: 'l-' + i, rect: [0, i, 10, 10] });
    }
    const v = GS.validateGraph(g);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toMatch(/超过上限/);
  });
});

describe('validateGraphRefs：悬挂 id 判红（设计 §6.3，与 links 的悬挂检测同型）', () => {
  const ids = new Set(['n-a', 'n-b']);

  it('全部引用都存在 ⇒ ok', () => {
    const v = GS.validateGraphRefs(okGraph(), ids);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('边的 from/to / 容器 children / pinned 指向不存在的节点 ⇒ 逐条点名', () => {
    const g = okGraph();
    g.edges[0].from.node = 'n-gone';
    g.containers[0].children = ['n-gone-2'];
    g.pinned = ['n-gone-3'];
    const v = GS.validateGraphRefs(g, ids);
    expect(v.ok).toBe(false);
    const all = v.errors.join('\n');
    expect(all).toContain('edges[0].from.node');
    expect(all).toContain('n-gone');
    expect(all).toContain('containers[0].children[0]');
    expect(all).toContain('pinned[0]');
    expect(v.errors.length).toBe(3);
  });

  it('没有 graph ⇒ ok（缺省 = 无附加结构）', () => {
    expect(GS.validateGraphRefs(undefined, ids).ok).toBe(true);
  });
});
