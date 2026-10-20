/* ============================================================
 * tests/cli-output-default.test.js — 台账 `G-11`：
 *   「给『不加开关时输出逐字相同』建一条对照断言」
 * ------------------------------------------------------------
 * ## 这条断言防的是什么（先想清再动手）
 * 给一条命令加一个**可选开关**（`--compact` / `--brief` / `--subtree` …）时，
 * **不加它的时候输出必须与加它之前逐字节相同**。否则就是"顺手改了默认行为"，
 * 而这是**最难发现**的一类回归：没有任何人会去对比"我没加开关时的输出"。
 *
 * 所以本文件的断言不是"跑两次一样"那么简单 —— 那只能抓住**不确定**（时间戳 / 随机 / 顺序），
 * 抓不住"确定地被改坏了"（例如把默认也改成 compact：两次都是 compact，照样逐字节相同 ✗）。
 * 因此本文件用**三条腿**同时钉住：
 *   ① **确定性**：同一命令两次 ⇒ 逐字节相同；
 *   ② **默认形状**：输出必须恰好等于 `JSON.stringify(载荷, null, 2) + '\n'`（**缩进口径**，可自证）；
 *      并且必须等于本文件里的 **GOLDEN 字面量**（**内容契约**，改默认就必须改它 —— 那是一次可见的动作）；
 *   ③ **开关有效且不越界**：带 `--compact` ⇒ 与默认**语义等价**（解析后逐字段相同）、**格式不同**、
 *      且恰好等于 `JSON.stringify(载荷) + '\n'`（单行）。
 *      ⇒ 反过来证明"默认真的没被改"（开关只影响它该影响的那一处）。
 *
 * ## 为什么挑 `list --json`
 *   · **有可选开关**：`--compact` 是**所有带 `--json` 的命令自动拥有**的开关
 *     （`cli/registry.js` 的派生规则：`json` ⇒ 补 `compact`），典型"后加的可选开关"；
 *   · **输出可复现**：`list --json` 的负载是 `{project, nodes:[{id,topic,depth,expanded,childCount}]}`
 *     （`src/query.js` 的 `buildNodeList`）—— **全部由树结构派生**，没有时间戳 / 随机 / 路径 / 热度；
 *   · **只读**：`list` 不写盘、不记访问埋点（对比 `get` 会 `recordVisit`、`search` 会读热度日志）；
 *   · **两种输出面都有**：文本树（真正"不带任何开关"）与 `--json`（开关可比）。
 *
 * ## 沙箱（铁律：测试绝不碰真实 `projects/`）
 * `AI_MINDMAP_PROJECTS_DIR` 在 **require CLI 之前**指到 `%TEMP%`，并**当场自证**重定向生效；
 * 收尾交给 `tests/_tmp-cleanup.js`（创建即登记，唯一删除入口）。
 *
 * ## 判别力证明（`testing-for-ai` B4：没红过的不算门禁）
 * 「造一次红」不放成一次性手工读数，而是**放进用例**（`judge()` 的注入表）：
 * 把默认输出**改坏**成 6 种形态（compact 泄漏 / 多一个空格 / 多一个字段 / 键序变 / 加时间戳 / 空格串），
 * 每一种都必须让 `judge()` **判红并给出对应的问题码**；真输出必须判绿。
 * ⇒ 这条断言在**每一次** `npm test` 都自己证明一次"它会红"。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);

/* ---- 沙箱：`AI_MINDMAP_PROJECTS_DIR` 必须在 require `cli/main.js` **之前**设好 ---- */
const SANDBOX = makeTmp('mm-g11-');
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;
process.env.MM_HEAT_SENSOR = 'off';        // 旁路埋点一个字节都不写（`list` 本来也不记，双保险）

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');

/* 重定向必须**当场**生效：否则夹具会写进真实 `projects/`（不可逆的污染）。 */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效：PROJECTS_DIR=' + core.PROJECTS_DIR + ' 期望=' + SANDBOX
    + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

afterAll(cleanupAll);

const PROJ = 'g11-default';
/** CLI 输出是 UTF-8 文本 ⇒ "逐字节"就是它的 UTF-8 字节序列（比较 Buffer，避免任何隐式归一化） */
const bytes = (s) => Buffer.from(String(s), 'utf8');
const run = (...argv) => invokeSync(argv);

/* ============================================================
 * GOLDEN —— `list` 在**固定夹具**上的默认输出（内容契约）
 * ------------------------------------------------------------
 * 它不是"手打的数字"，而是**跑出来的读数**（取证：`.review/20261020-视觉与确定性/probe-g11.out.json`）。
 * 夹具在下面 `beforeAll` 里由 CLI 自己建（`init` + `add --id …`），id / 标题 / 层级全都写死 ⇒ 可复现。
 *
 * ⚠️ 改 GOLDEN = 承认"默认输出的内容变了"。那必须是一次**有意的、可见的**动作
 * （通常是改了 `src/query.js` 的 `buildNodeList` 并同步契约文档），而不是顺手改出来的。
 * ============================================================ */
const GOLDEN_TEXT = '▾ root  确定性样本\n  ▸ g11-a  甲节点\n    ▸ g11-b  乙节点\n';
const GOLDEN_JSON = {
  project: PROJ,
  nodes: [
    { id: 'root', topic: '确定性样本', depth: 0, expanded: true, childCount: 1 },
    { id: 'g11-a', topic: '甲节点', depth: 1, expanded: false, childCount: 1 },
    { id: 'g11-b', topic: '乙节点', depth: 2, expanded: false, childCount: 0 }
  ]
};
/** 默认输出**必须**是这一串（2 空格缩进 + 末尾一个换行） */
const GOLDEN_JSON_TEXT = JSON.stringify(GOLDEN_JSON, null, 2) + '\n';

/** 夹具：一次建好，所有用例只读 */
function buildFixture() {
  const steps = [
    ['init', PROJ, '--title', '确定性样本'],
    ['add', PROJ, 'root', '--id', 'g11-a', '--topic', '甲节点'],
    ['add', PROJ, 'g11-a', '--id', 'g11-b', '--topic', '乙节点']
  ];
  for (const argv of steps) {
    const r = run(...argv);
    if (r.code !== 0) throw new Error('夹具建不起来（' + argv.join(' ') + '）：' + r.stdout + r.stderr);
  }
}
buildFixture();

/* ============================================================
 * 判据本体（**纯函数**，可注入 ⇒ 判别力证明能逐条注入坏输入）
 * ------------------------------------------------------------
 * 四组输入：默认输出跑两次 + 带无关开关跑一次 + GOLDEN。
 * 输出 `{ok, problems:[{code, why}]}`；**问题码是判据的"判定档"**（照 `B4c`：先数清能判几种）。
 * 判定档 = { 通过 } ∪ { not-json, nondeterministic, format-drift, content-drift,
 *                       switch-noop, switch-semantic, switch-format }（7 种判红 + 1 种通过）
 * ============================================================ */
function judge(o) {
  const problems = [];
  const add = (code, why) => problems.push({ code: code, why: why });
  const d1 = String(o.default1);
  const d2 = String(o.default2);
  const c = String(o.compact);

  // ① 确定性：两次逐字节相同
  if (!bytes(d1).equals(bytes(d2))) {
    add('nondeterministic', '同一条命令（不带开关）跑两次输出不同 ⇒ 默认输出里混进了不确定来源'
      + '（时间戳 / 随机 / 顺序 / 路径）—— 这种输出不能当契约');
  }
  // ② 默认形状：必须是"载荷的 2 空格渲染 + 一个换行"
  let payload = null;
  try { payload = JSON.parse(d1); }
  catch (e) { add('not-json', '默认输出不是一份可解析的 JSON：' + (e && e.message)); }
  if (payload !== null) {
    const canonical = JSON.stringify(payload, null, 2) + '\n';
    if (d1 !== canonical) {
      add('format-drift', '默认输出的**格式**变了：它不等于自己载荷的 2 空格渲染（多/少空白、缩进被改、'
        + '末尾换行变了 —— 「顺手把 --compact 的效果做进默认」就是长这样）');
    }
    // ③ 内容契约
    if (JSON.stringify(payload) !== JSON.stringify(GOLDEN_JSON)) {
      add('content-drift', '默认输出的**内容**变了（与 GOLDEN 不等）—— 字段增删 / 取值变 / 键序变。'
        + '若这是有意的契约变更，同批改 GOLDEN 并更新 `docs/CLI.md`；否则就是顺手改坏了默认');
    }
  }
  // ④ 开关真的起作用（否则"默认没被改"这句话没有对照物）
  if (c === d1) {
    add('switch-noop', '带 `--compact` 的输出与不带开关时**逐字节相同** ⇒ 这个开关根本没起作用，'
      + '本断言"默认没被改"也就失去了对照物');
  }
  let cpayload = null;
  try { cpayload = JSON.parse(c); }
  catch (e) { add('not-json', '带 `--compact` 的输出不是一份可解析的 JSON：' + (e && e.message)); }
  if (cpayload !== null) {
    // ⑤ 语义等价：开关只许改格式，不许改内容
    if (JSON.stringify(cpayload) !== JSON.stringify(payload === null ? GOLDEN_JSON : payload)) {
      add('switch-semantic', '`--compact` 改动了**语义**（解析后逐字段与默认输出不同）—— '
        + '它按契约只该改缩进与换行');
    }
    // ⑥ 紧凑形状：单行 + 一个换行
    if (c !== JSON.stringify(cpayload) + '\n') {
      add('switch-format', '`--compact` 的输出不是"单行 JSON + 一个换行"');
    }
  }
  return { ok: problems.length === 0, problems: problems };
}

/** 跑一轮完整取证（默认两次 + 不带开关的文本两次 + 带开关一次），返回原始字符串 */
function capture() {
  const text1 = run('list', PROJ).stdout;
  const text2 = run('list', PROJ).stdout;
  // 顺序：**先带开关、后不带开关** —— 若有跨调用的状态泄漏，默认那一次就会被污染（这是个真坑：
  // `ctx.args` 是每次 dispatch 现建的，但"默认没被改"这句话只有在顺序反过来时才验得到）
  const compact = run('list', PROJ, '--json', '--compact').stdout;
  const json1 = run('list', PROJ, '--json').stdout;
  const json2 = run('list', PROJ, '--json').stdout;
  return { text1: text1, text2: text2, compact: compact, json1: json1, json2: json2 };
}

/* ==================================================================
 * 一、不加开关时输出逐字相同（G-11 的正面判据）
 * ================================================================== */
describe('G-11 · 不加开关时输出逐字相同', () => {
  const cap = capture();

  it('文本模式（**真正不带任何开关**）跑两次 ⇒ 逐字节相同', () => {
    expect(cap.text1.length).toBeGreaterThan(0);
    expect(bytes(cap.text1).equals(bytes(cap.text2))).toBe(true);
    expect(cap.text1).not.toContain('\r');   // 行尾口径：CLI 输出只有 LF
  });

  it('文本模式等于 GOLDEN（默认呈现的内容契约）', () => {
    expect(cap.text1).toBe(GOLDEN_TEXT);
  });

  it('`--json`（未加任何额外开关）跑两次 ⇒ 逐字节相同', () => {
    expect(bytes(cap.json1).equals(bytes(cap.json2))).toBe(true);
    expect(cap.json1).not.toContain('\r');
  });

  it('`--json` 默认输出 == 载荷的 2 空格渲染 + 一个换行（缩进口径）', () => {
    const parsed = JSON.parse(cap.json1);
    expect(cap.json1).toBe(JSON.stringify(parsed, null, 2) + '\n');
  });

  it('`--json` 默认输出 == GOLDEN（默认呈现的内容契约）', () => {
    expect(cap.json1).toBe(GOLDEN_JSON_TEXT);
  });
});

/* ==================================================================
 * 二、带一个无关开关 ⇒ 语义等价、格式不同（证明开关真起作用，且默认没被改）
 * ================================================================== */
describe('G-11 · 带 `--compact` 时语义等价、格式不同', () => {
  const cap = capture();
  const parsedDefault = JSON.parse(cap.json1);
  const parsedCompact = JSON.parse(cap.compact);

  it('逐字段语义等价（开关只许改格式）', () => {
    expect(parsedCompact).toEqual(parsedDefault);
  });

  it('格式确实不同（否则这个开关是空转的）', () => {
    expect(bytes(cap.compact).equals(bytes(cap.json1))).toBe(false);
    expect(bytes(cap.compact).length).toBeLessThan(bytes(cap.json1).length);
  });

  it('紧凑形态 = 单行 JSON + 一个换行', () => {
    expect(cap.compact).toBe(JSON.stringify(parsedCompact) + '\n');
    expect(cap.compact.slice(0, -1)).not.toContain('\n');
  });

  it('带开关跑过之后，默认输出仍然是 GOLDEN（没有跨调用状态泄漏）', () => {
    // `capture()` 里 `--compact` 是**先**跑的 ⇒ 这一条才有意义
    expect(cap.json1).toBe(GOLDEN_JSON_TEXT);
    expect(cap.json2).toBe(GOLDEN_JSON_TEXT);
  });
});

/* ==================================================================
 * 三、判据的**判别力证明**（B4：没红过的不算门禁）
 * ------------------------------------------------------------------
 * 把真默认输出**改坏**成 6 种形态 ⇒ `judge()` 必须判红并给出对应问题码。
 * 真输出（同一份）⇒ 必须判绿。**每一种"改坏"都对应一类真实会发生的事故**。
 * ================================================================== */
describe('G-11 · 判别力证明：改坏默认输出 ⇒ 判据必须红', () => {
  const cap = capture();
  const genuine = { default1: cap.json1, default2: cap.json2, compact: cap.compact };
  const codes = (r) => r.problems.map((p) => p.code);

  it('对照组：真输出 ⇒ 判绿（并逐个说明它能判几种档）', () => {
    const r = judge(genuine);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('注入 ①「--compact 的效果做进了默认」（默认被渲染成单行）⇒ format-drift', () => {
    const leaked = JSON.stringify(JSON.parse(cap.json1)) + '\n';
    const r = judge({ default1: leaked, default2: leaked, compact: cap.compact });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('format-drift');
  });

  it('注入 ②「默认输出末尾多了一个空格」⇒ format-drift（只改空白也算改默认）', () => {
    const sp = cap.json1.replace(/\n$/, ' \n');
    const r = judge({ default1: sp, default2: sp, compact: cap.compact });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('format-drift');
  });

  it('注入 ③「默认输出多了一个字段」⇒ content-drift', () => {
    const p = JSON.parse(cap.json1);
    p.nodes[0].generatedAt = '2026-01-01T00:00:00Z';
    const extra = JSON.stringify(p, null, 2) + '\n';
    const r = judge({ default1: extra, default2: extra, compact: cap.compact });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('content-drift');
  });

  it('注入 ④「默认输出键序被改」⇒ content-drift（JSON 语义相同、逐字节不同，也要抓）', () => {
    const p = JSON.parse(cap.json1);
    const n = p.nodes[0];
    p.nodes[0] = { topic: n.topic, id: n.id, depth: n.depth, expanded: n.expanded, childCount: n.childCount };
    const reordered = JSON.stringify(p, null, 2) + '\n';
    const r = judge({ default1: reordered, default2: reordered, compact: cap.compact });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('content-drift');
  });

  it('注入 ⑤「默认输出混进了运行时刻」⇒ nondeterministic（两次不同）', () => {
    const a = cap.json1.replace('"project"', '"at":"2026-01-01T00:00:00.000Z",\n  "project"');
    const b = cap.json1.replace('"project"', '"at":"2026-01-01T00:00:01.000Z",\n  "project"');
    const r = judge({ default1: a, default2: b, compact: cap.compact });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('nondeterministic');
  });

  it('注入 ⑥「开关空转」（--compact 与默认逐字节相同）⇒ switch-noop', () => {
    const r = judge({ default1: cap.json1, default2: cap.json2, compact: cap.json1 });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('switch-noop');
  });

  it('注入 ⑦「开关改动了语义」（--compact 少了一个节点）⇒ switch-semantic', () => {
    const p = JSON.parse(cap.compact);
    p.nodes.pop();
    const r = judge({ default1: cap.json1, default2: cap.json2, compact: JSON.stringify(p) + '\n' });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('switch-semantic');
  });

  it('注入 ⑧「默认输出根本不是 JSON」⇒ not-json（采不到真值也算红）', () => {
    const r = judge({ default1: '', default2: '', compact: cap.compact });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('not-json');
  });
});
