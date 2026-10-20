/* ============================================================
 * tests/tag-census.test.js — 【W5】`tags` 标签清单（只读命令）
 * ------------------------------------------------------------
 * 判据出处：`.review/20261010-卖点与功能-常驻讨论/待做清单.md:126`（`W5a` 前半句
 *   「列出**全部标签 + 计数** ✓（现在 `stats` 只给标签总数 ✗）」）与
 *   `.review/20261020-W5-tag-relations/00-定题.md`（本批的定题文档：做哪半、不做哪半、为什么）。
 *
 * ## 这个文件守什么
 *   A. **纯逻辑**（`src/query.js` 的 `computeTagCounts` —— "数标签"的**唯一实现**）：
 *      A1 遍历面含根节点（与 `computeStats` 同一面，两个读数才对得上）
 *      A2 逐标签计**节点数**（不是字符串出现次数）
 *      A3 同一节点上重复写同一个标签只算 1 次
 *      A4 非字符串 / 空串标签**不算**且不炸
 *      A5 `counts` 按**码点**升序（确定序 —— 输出要能两跑 sha256 相同，不许用 locale）
 *      A6 深树里只出现在子节点上的标签也数得到；`untaggedNodes` 口径
 *   B. **命令面**（沙箱 `AI_MINDMAP_PROJECTS_DIR`，进程内 `invokeSync`）：
 *      B1 全库档 = 清单（`mode=library`、`projects` 升序、**不给** `vocab`/`inVocab`）
 *      B2 点名档只扫点名的项目；点名不存在的 ⇒ exit 1 并列出库里现有的
 *      B3 `--vocab` 三条判据的**判别力**（造坏 ⇒ 红）：
 *         闭集（造一个不在 §4 的标签）· 落点下限（4 落点 ⇒ 红）· 门面特性放宽（同为 4 落点 ⇒ 绿）
 *         · 反向缺口（§4 有、0 落点 ⇒ 进 `unused`）
 *      B4 四条闸门各自 exit 1 + `error:`（`--vocab` 不点名 / `--vocab=false` / 不存在的项目）
 *      B5 **只用一处实现**：单项目 `tags` 的 tagCount/nodes/taggedNodes 与 `stats` 逐项相等
 *      B6 **只读**：跑完项目目录逐字节 + mtime 不变（独立对拍，不信命令自报）
 *      B7 **确定性**：`--json` 两跑逐字节相同（含 `--vocab` 档）
 *
 * ## 环境要点（与 tests/search-all.test.js 同口径）
 *   1) `AI_MINDMAP_PROJECTS_DIR` 必须在 require `cli/main.js` **之前**设好，并**当场自证**重定向生效；
 *   2) 夹具与断言都在 `%TEMP%` 沙箱里 ⇒ **绝不碰真实 `projects/`**；
 *   3) 端到端一律**进程内** `invokeSync`（不起子进程）；
 *   4) 词表夹具的标签名**从 `docs/TAGS.md` §4 现取**（不写死）：改词表不该让本文件按旧名单判红，
 *      而"门面特性"那一档只能从文档里读 —— 它正是判据要证明会生效的东西。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ---- 沙箱：必须在 require cli/main.js **之前**设好 ---- */
const SANDBOX = makeTmp('mm-tag-census-');
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const query = require('../src/query.js');

afterAll(cleanupAll);

/* 重定向必须**当场**生效：否则夹具会写进真实 projects/。 */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效：PROJECTS_DIR=' + core.PROJECTS_DIR + ' 期望=' + SANDBOX
    + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

/* ---------------- 纯逻辑夹具（自己搓树，不碰盘） ---------------- */
const nd = (id, tags, children) => {
  const o = { id: id, topic: 't ' + id };
  if (tags !== undefined) o.tags = tags;
  if (children) o.children = children;
  return o;
};
const run = (argv) => invokeSync(argv);
const jrun = (argv) => {
  const r = run(argv);
  expect(r.code, argv.join(' ') + ' 失败：' + r.stdout).toBe(0);
  return JSON.parse(r.stdout);
};

/* §4 的**独立**解析（本文件不 require 命令层的 `readTagVocabulary`：那是被测实现，
 * 用它造夹具就成了自证。这里按 `docs/TAGS.md` 自己的表格形状再读一遍）。 */
const VOCAB = [];
{
  const lines = fs.readFileSync(path.join(ROOT, 'docs', 'TAGS.md'), 'utf8').split(/\r?\n/);
  let inSec = false;
  for (const line of lines) {
    if (!inSec) { if (/^##\s*4\./.test(line)) inSec = true; continue; }
    if (/^##\s*5\./.test(line)) break;
    const m = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (m) VOCAB.push({ tag: m[1], facade: line.indexOf('门面特性') >= 0 });
  }
}
const PLAIN = VOCAB.filter((x) => !x.facade).map((x) => x.tag);
const FACADE = VOCAB.filter((x) => x.facade).map((x) => x.tag);

/* ============================================================================
 * A. 纯逻辑：`computeTagCounts`
 * ========================================================================== */
describe('A · src/query.js 的 computeTagCounts（数标签的唯一实现）', () => {
  it('A1 遍历面含根节点（与 computeStats 同一面 ⇒ 两个读数才对得上）', () => {
    const root = nd('root', ['甲'], [nd('c1', ['乙'], [])]);
    const r = query.computeTagCounts(root);
    expect(r.nodes).toBe(2);
    expect(r.taggedNodes).toBe(2);
    expect(r.untaggedNodes).toBe(0);
    const tags = r.counts.map((c) => c.tag);
    expect(tags).toContain('甲');   // 根节点自己的标签**算**（否则与 stats 的 tagSet 对不上）
    expect(tags).toContain('乙');
  });

  it('A2 逐标签计**节点数**（不是字符串出现次数）', () => {
    const root = nd('root', [], [
      nd('a', ['甲'], []), nd('b', ['甲'], []), nd('c', ['甲', '乙'], [])
    ]);
    const r = query.computeTagCounts(root);
    const m = new Map(r.counts.map((c) => [c.tag, c.nodes]));
    expect(m.get('甲')).toBe(3);
    expect(m.get('乙')).toBe(1);
    expect(r.taggedNodes).toBe(3);
    expect(r.untaggedNodes).toBe(1);   // 只有 root 没标签
  });

  it('A3 同一节点上重复写同一个标签只算 1 次（节点数语义）', () => {
    const root = nd('root', ['甲', '甲', '甲'], []);
    const r = query.computeTagCounts(root);
    expect(r.counts).toEqual([{ tag: '甲', nodes: 1 }]);
    expect(r.taggedNodes).toBe(1);
  });

  it('A4 非字符串 / 空串标签**不算**且不炸（数据坏了也不能把读数变成 0）', () => {
    const root = nd('root', ['甲', '', null, 42, '   ', { x: 1 }], [nd('c', ['甲'], [])]);
    const r = query.computeTagCounts(root);
    expect(r.counts).toEqual([{ tag: '甲', nodes: 2 }]);
  });

  it('A5 counts 按**码点**升序（确定序：两跑逐字节相同，不许用 localeCompare）', () => {
    const root = nd('root', ['b', 'A', '甲', 'a', 'Z', '拥塞控制'], []);
    const r = query.computeTagCounts(root);
    const got = r.counts.map((c) => c.tag);
    expect(got).toEqual(got.slice().sort((x, y) => (x < y ? -1 : (x > y ? 1 : 0))));
    // 码点序 ⇒ 大写 ASCII 在小写之前（localeCompare 在部分 locale 下会反过来）
    expect(got.indexOf('A')).toBeLessThan(got.indexOf('a'));
  });

  it('A6 深树：只出现在子节点上的标签也数得到；untaggedNodes = nodes - taggedNodes', () => {
    const root = nd('root', [], [
      nd('c1', [], [nd('c11', [], [nd('c111', ['深'], [])]), nd('c12', [], [])])
    ]);
    const r = query.computeTagCounts(root);
    expect(r.nodes).toBe(5);
    expect(r.taggedNodes).toBe(1);
    expect(r.untaggedNodes).toBe(4);
    expect(r.counts).toEqual([{ tag: '深', nodes: 1 }]);
  });
});

/* ============================================================================
 * B. 命令面（沙箱）
 * ========================================================================== */
const dirOf = (n) => path.join(SANDBOX, n);
const fileOf = (n) => path.join(dirOf(n), n + '.json');
const logOf = (n) => path.join(dirOf(n), '.changes.jsonl');
const mkProject = (n, children) => {
  fs.mkdirSync(dirOf(n), { recursive: true });
  fs.writeFileSync(fileOf(n), JSON.stringify({
    meta: { name: n, author: '', version: '0.18.0', formatVersion: 2 },
    format: 'node_tree',
    data: { id: 'root', topic: n, expanded: true, children: children }
  }, null, 2), 'utf8');
};
const snapOf = (n) => [fileOf(n), logOf(n)].map((f) => (fs.existsSync(f)
  ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16)
    + '@' + fs.statSync(f).mtimeMs
  : '-')).join(' | ');

/* 夹具词**从 §4 现取**（不写死名单）；取不到就让 A 段之外的第一条断言直接红，
 * 而不是静默跳过 —— "判据没有主语"本身就是要报的错。 */
const T_FLOOR = PLAIN.length > 1 ? PLAIN[1] : null;
const T_UNUSED = PLAIN.length > 0 ? PLAIN[0] : null;
const T_FACADE = FACADE.length > 0 ? FACADE[0] : null;
const T_MADEUP = '不在词表里的造坏标签';

const PA = 'probe-tag-a';     // 判据面
const PB = 'probe-tag-b';     // 跨项目合并面
const node = (id, tags) => ({ id: id, topic: 'n ' + id, expanded: true, tags: tags, children: [] });

describe('B · `tags` 命令（沙箱，进程内）', () => {
  it('B0 前提：§4 里解析出足够造夹具的标签（普通 ≥2、门面特性 ≥1）', () => {
    expect(VOCAB.length, 'docs/TAGS.md §4 解析不出标签表').toBeGreaterThanOrEqual(3);
    expect(PLAIN.length, '§4 的普通标签不足 2 个').toBeGreaterThanOrEqual(2);
    expect(FACADE.length, '§4 里没有写明「门面特性」的行 —— 放宽口径没有主语，判据 F 无从证明')
      .toBeGreaterThanOrEqual(1);
  });

  it('B1 全库档 = 清单（mode=library、projects 升序、不给 vocab / inVocab）', () => {
    mkProject(PA, [].concat(
      [1, 2, 3, 4].map((i) => node('a-n' + i, [T_FLOOR])),
      [5, 6, 7, 8].map((i) => node('a-n' + i, [T_FACADE])),
      [node('a-n9', [T_MADEUP]), node('a-n10', [])]));
    mkProject(PB, [].concat(
      [1, 2, 3].map((i) => node('b-m' + i, [T_FACADE])),
      [node('b-m4', [T_FLOOR])]));
    const j = jrun(['tags', '--json']);
    expect(j.mode).toBe('library');
    expect(j.projects).toEqual([PA, PB]);
    expect(j.tagCount).toBe(3);           // T_FLOOR / T_FACADE / T_MADEUP
    // 遍历面**含根节点**（与 computeStats 同一面）⇒ 每个项目多 1 个节点、且根节点无标签：
    //   PA = root + 10 个子节点（9 个带标签）· PB = root + 4（全带标签）
    expect(j.nodes).toBe(16);
    expect(j.taggedNodes).toBe(13);
    expect(j.untaggedNodes).toBe(3);      // 两个 root + PA 的 a-n10
    expect(j.vocab).toBeUndefined();      // 不给 --vocab 就不读词表、也不给判据
    expect(j.tags.every((t) => t.inVocab === undefined)).toBe(true);
    // 顺序 = 节点数降序 → 标签名升序
    expect(j.tags.map((t) => t.tag)).toEqual([T_FACADE, T_FLOOR, T_MADEUP]);
    expect(j.tags[0].projects).toEqual([
      { project: PA, nodes: 4 }, { project: PB, nodes: 3 }
    ]);
  });

  it('B2 点名档只扫点名的项目；点名不存在的 ⇒ exit 1 并列出库里现有的', () => {
    const j = jrun(['tags', PA, '--json']);
    expect(j.mode).toBe('named');
    expect(j.projects).toEqual([PA]);
    expect(j.nodes).toBe(11);             // root + 10 个子节点（同上：遍历面含根）
    expect(j.taggedNodes).toBe(9);
    expect(j.untaggedNodes).toBe(2);
    // 同一份数据在全库档里 tagCount 也是 3 ⇒ 点名档不该多出 PB 的标签
    expect(j.tagCount).toBe(3);

    const bad = run(['tags', 'probe-tag-不存在']);
    expect(bad.code).toBe(1);
    expect(bad.stdout.indexOf('error: ')).toBe(0);
    expect(bad.stdout).toContain(PA);     // 报文里必须列出现有什么（"我怎么写才对"）
  });

  it('B3 三条词表判据**有判别力**（造坏 ⇒ 红），且「门面特性」的放宽真的生效', () => {
    const j = jrun(['tags', PA, '--vocab', '--json']);
    const byTag = new Map(j.tags.map((t) => [t.tag, t]));
    // ① 闭集：造的那个不在 §4 的标签必须被判出来
    expect(byTag.get(T_MADEUP).inVocab).toBe(false);
    expect(byTag.get(T_FLOOR).inVocab).toBe(true);
    expect(j.vocab.source).toBe('docs/TAGS.md §4');
    expect(j.vocab.count).toBe(VOCAB.length);
    // ② 落点下限：两个标签**各 4 个落点**，结局必须相反 ——
    //    普通标签 4 < 5 ⇒ 红；门面特性 4 ≥ 3 ⇒ 绿。差别只来自"下限 5 还是 3"。
    const below = new Map(j.vocab.belowFloor.map((b) => [b.tag, b]));
    expect(below.get(T_FLOOR)).toEqual({ tag: T_FLOOR, nodes: 4, floor: 5 });
    expect(below.has(T_FACADE)).toBe(false);   // ← 解析器若忽略「门面特性」，这里会变红
    // ③ 反向缺口：§4 有、本探针 0 落点 ⇒ unused；有落点的不许混进去
    expect(j.vocab.unused).toContain(T_UNUSED);
    expect(j.vocab.unused).not.toContain(T_FLOOR);
    expect(j.vocab.unused).not.toContain(T_FACADE);
    // ②与③不重叠：0 落点的标签只进 unused，不进 belowFloor
    expect(below.has(T_UNUSED)).toBe(false);
  });

  it('B4 闸门：`--vocab` 不点名 / `--vocab=false` / 不存在项目 ⇒ 各自 exit 1 + error:', () => {
    const cases = [
      [['tags', '--vocab'], '--vocab 不点名项目'],
      [['tags', PA, '--vocab=false'], '--vocab 是纯布尔，不收 = 赋值'],
      [['tags', 'probe-tag-不存在'], '点名不存在的项目']
    ];
    cases.forEach(([argv, why]) => {
      const r = run(argv);
      expect(r.code, why + ' 应该 exit 1').toBe(1);
      expect(r.stdout.indexOf('error: '), why + ' 的 stdout 应以 error: 开头').toBe(0);
    });
    // `--vocab` 是纯布尔：写在它后面的项目名不许被吞成值
    const mix = jrun(['tags', PA, '--vocab', PB, '--json']);
    expect(mix.projects).toEqual([PA, PB]);
    expect(mix.vocab).toBeTruthy();
  });

  it('B5 数标签只有一处实现：单项目 tags 与 stats 的三个读数逐项相等', () => {
    [PA, PB].forEach((n) => {
      const t = jrun(['tags', n, '--json']);
      const s = jrun(['stats', n, '--json']);
      expect([t.tagCount, t.nodes, t.taggedNodes]).toEqual([s.tags, s.nodes, s.taggedNodes]);
      // 逐项目分布之和 = 逐标签节点数之和（一节点可多标签 ⇒ 它 ≥ 带标签节点数）
      const sum = t.tags.reduce((a, x) => a + x.nodes, 0);
      const per = t.tags.reduce((a, x) => a + x.projects.reduce((b, y) => b + y.nodes, 0), 0);
      expect(per).toBe(sum);
      expect(sum).toBeGreaterThanOrEqual(t.taggedNodes);
    });
  });

  it('B6 只读：跑完全部档位后两个项目的 JSON 与变更日志逐字节 + mtime 不变', () => {
    const before = [snapOf(PA), snapOf(PB)];
    run(['tags', PA, PB, '--json']);
    run(['tags', PA, '--vocab', '--json']);
    run(['tags', PA, PB]);
    run(['tags', '--json']);
    expect([snapOf(PA), snapOf(PB)]).toEqual(before);
    expect(fs.existsSync(logOf(PA))).toBe(false);   // 连变更日志都不该被创建
  });

  it('B7 确定性：`--json` 与 `--vocab --json` 各两跑逐字节相同（无时间戳、排序不走 locale）', () => {
    const a1 = run(['tags', PA, PB, '--json']);
    const a2 = run(['tags', PA, PB, '--json']);
    const c1 = run(['tags', PA, '--vocab', '--json']);
    const c2 = run(['tags', PA, '--vocab', '--json']);
    expect(a1.code).toBe(0);
    expect(c1.code).toBe(0);
    expect(a1.stdout).toBe(a2.stdout);
    expect(c1.stdout).toBe(c2.stdout);
    expect(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(a1.stdout)).toBe(false);
  });
});
