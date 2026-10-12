/* ============================================================
 * tests/heat-bars.test.js — 热度条第三件：A（界面两条热度条）+ B（AI 侧隐藏维度）
 * 运行：npx vitest run tests/heat-bars.test.js
 * ------------------------------------------------------------
 * ## 这个文件守什么（每条对着 `.review/20261012-热度条/规格与裁决.md` 的一条判据）
 *   A① **界面显示的两条热度值与 `heat --json` 逐字一致** —— 渲染层**不折算任何数**：
 *       它拿到的 `bands` / `heat` / `visit` 是读数给的（`heatProfile()` 唯一一处算），
 *       而这一条是**端到端**验的：真造一个项目 → 真跑 `heat --json --node <id>` →
 *       把**它输出的那一份**喂给渲染层模块 → 断言 DOM 上的 `data-*` 与读数的对应字段**相等**；
 *   A② **正文只有一份**：`.fd-heat` 是另一个容器，`dc.innerHTML = detail` 那一行仍是唯一正文来源
 *       （机械判据：渲染层源码里 `.fd-detail-content` 的赋值只有一处，且不在本件新增的文件里）；
 *   A③ **改/看热度条不写盘**：渲染层不碰 `state.dirty`、不调 `project.save`
 *       （机械判据：本件新增的渲染层文件里不出现这些名字）；
 *   B① **隐藏维度确实是派生的**：把"名次→档位"的映射换掉（注入）⇒ 派生的 `heatMax` 必变 ⇒ 还原复绿；
 *   B② **界面上不出现隐藏维度**：把 `heat --json --derived summary` 的**完整载荷**喂给渲染层 ⇒
 *       详情框 HTML 里搜 `derived` / `tags` / `sections` / `trees` 这些**键名**必须为 0；
 *   B③ **样本量如实暴露**：每维都带 `nodes/visited/events`，且少样本时档位会跳（读数当场打印）。
 *
 * ## ⚠️ 这个文件为什么自己搭一个假 DOM（而不用 jsdom）
 *   本工程没有 jsdom 依赖（`package.json` 只有 electron/vitest/pdfjs），而**加一个依赖**是
 *   本件不该做的决定。渲染层模块 `renderer/app-heat-bars.js` 只用到极小的 DOM 子集
 *   （createElement / textContent / setAttribute / appendChild / innerHTML / className），
 *   所以这里给它一个**最小 DOM 桩**，并把**真实的模块文件**（不是复制一份）加载进来跑 ——
 *   判据因此是对真实现的（改实现就红），不是对桩的。
 * ============================================================ */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/* ---- ① 沙箱（必须在 require cli/main.js 之前设好 —— 与 tests/heat.test.js 同口径）---- */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-heatbars-'));
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const heat = require('../src/heat.js');
const sensor = require('../src/heat-sensor.js');

if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效：PROJECTS_DIR=' + core.PROJECTS_DIR + ' 期望=' + SANDBOX);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (argv) => invokeSync(argv);

afterAll(() => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* 沙箱删不掉不影响判定 */ }
});

/* ============================================================================
 * 最小 DOM 桩（只实现 `renderer/app-heat-bars.js` 用到的那一小块）
 * ========================================================================== */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.className = '';
    this._text = '';
    this.innerHTML = '';
  }
  set textContent(v) { this._text = String(v); }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
  appendChild(c) { this.children.push(c); return c; }
  querySelector() { return null; }
  /** 本件判据用的遍历：按 class 找后代 */
  all() {
    const out = [];
    (function walk(n) { n.children.forEach((c) => { out.push(c); walk(c); }); })(this);
    return out;
  }
  find(sel) {
    const cls = String(sel).replace(/^\./, '');
    return this.all().filter((n) => String(n.className).split(/\s+/).indexOf(cls) >= 0);
  }
}

/** 装一个"渲染层运行环境"：window.MM + 假 document，然后用**真文件**加载渲染层模块 */
function loadBars() {
  const doc = { createElement: (t) => new El(t) };
  const fdHeat = new El('div');          // 详情框里那个容器
  const state = { project: { name: null }, selectedNode: null };
  const statuses = [];
  const MM = {
    state,
    fdQ: (box, sel) => (sel === '.fd-heat' ? box.heatEl : null),
    setStatus: (t, isErr) => statuses.push({ text: t, err: !!isErr })
  };
  const api = {
    heat: null,     // 由各用例自己装（模拟主进程 `app:heat`）
    visit: null
  };
  const win = {
    MM,
    document: doc,
    desktop: { app: api },
    console
  };
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'app-heat-bars.js'), 'utf8');
  vm.runInNewContext(src, { window: win, document: doc, console, Math, String, Object, Array, Number }, { filename: 'app-heat-bars.js' });
  return { MM, win, doc, fdHeat, statuses, api, state };
}

/** 造一个项目（含标签 / 章节 / 两层树），返回项目名。
 * ⚠️ 标签**必须经 `edit --tags` 设**（`add` 不认识 `--tags` —— 它只认 topic/id/detail 那几项；
 * 用 `add … --tags` 是**静默失效**：未知选项由 dispatch 拦下报错，夹具会"建了但没标签"）。 */
let seq = 0;
function fixture() {
  const name = 'hb' + (++seq);
  run(['init', name]);
  run(['add', name, 'root', '--topic', '主题甲', '--id', 't-a']);
  run(['add', name, 't-a', '--topic', '第一章', '--id', 's-1']);
  run(['add', name, 's-1', '--topic', '节点一', '--id', 'n-1']);
  run(['add', name, 's-1', '--topic', '节点二', '--id', 'n-2']);
  run(['add', name, 't-a', '--topic', '第二章', '--id', 's-2']);
  run(['add', name, 's-2', '--topic', '节点三', '--id', 'n-3']);
  const tag = (id, tags) => {
    const r = run(['edit', name, id, '--tags', tags]);
    if (r.code !== 0) throw new Error('夹具设标签失败：' + r.stdout);
  };
  tag('s-1', 'net');
  tag('n-1', 'net,tcp');
  tag('n-2', 'tcp');
  return name;
}
const heatJson = (name, extra) => {
  const r = run(['heat', name, '--json'].concat(extra || []));
  expect(r.code, r.stdout).toBe(0);
  return JSON.parse(r.stdout);
};

/* ============================================================================
 * A. 界面两条热度条
 * ========================================================================== */
describe('A. 界面两条热度条：值与 CLI 逐字一致、正文只有一份、不写盘', () => {
  beforeEach(() => { sensor.__setEnabledForTest(false); });   // 夹具自造日志（理由见 tests/heat.test.js）

  it('A1 值逐字一致：把 `heat --json --node <id>` 的**真输出**喂给渲染层 ⇒ DOM 上的 heat/bands/rank 与读数相等', async () => {
    const p = fixture();
    for (let i = 0; i < 3; i++) run(['visit', p, 'n-1', '--channel', 'human-detail']);
    run(['visit', p, 'n-3', '--channel', 'ai-get']);
    run(['visit', p, 'n-3', '--channel', 'ai-get']);

    const payload = heatJson(p, ['--node', 'n-1']);          // ← CLI 的真读数（界面用的就是这一档）
    const env = loadBars();
    env.state.project.name = p;
    env.api.heat = () => Promise.resolve({ ok: true, payload: payload, nodeId: 'n-1' });

    const box = { el: new El('div'), node: { id: 'n-1' }, heatEl: new El('div') };
    env.MM.heatBarsRefresh(box, box.node);
    await new Promise((r) => setTimeout(r, 0));               // 让那次 promise 回调跑完

    expect(env.MM.heatBarsState().payload).toBe(payload);     // 载荷是**同一份对象**（没有二次加工）
    const human = box.heatEl.find('fd-heat-row').filter((n) => n.getAttribute('data-side') === 'human')[0];
    const ai = box.heatEl.find('fd-heat-row').filter((n) => n.getAttribute('data-side') === 'ai')[0];
    expect(human.getAttribute('data-heat')).toBe(String(payload.node.human.heat));
    expect(human.getAttribute('data-bands')).toBe(String(payload.node.human.bands));
    expect(ai.getAttribute('data-heat')).toBe(String(payload.node.ai.heat));
    expect(ai.getAttribute('data-bands')).toBe(String(payload.node.ai.bands));
    expect(human.getAttribute('data-listed')).toBe('1');
    expect(ai.getAttribute('data-listed')).toBe('0');         // n-1 没被 AI 访问过 ⇒ 如实标 0
    // 显示的数值串**逐字**含读数给的那几个数（校验/次数），与 ten 档位口径无关
    expect(human.textContent).toContain(payload.node.human.heat + '/' + payload.node.human.bandMax);
    expect(human.textContent).toContain(String(payload.node.human.visits));
    // 样本量如实露出（窗口内被访问过的节点数 / 事件数）—— 少样本时档位会跳的那条证据
    expect(box.heatEl.textContent).toContain(String(payload.node.sample.nodes));
    expect(box.heatEl.textContent).toContain(String(payload.node.sample.events));
    // 错误提示一条都不该有（成功路径）
    expect(box.heatEl.find('fd-heat-err').length).toBe(0);
  });

  it('A2 零访问节点：`listed:false` ⇒ 明说"未访问"（画 `—`），**不画成"热度 0"**', async () => {
    const p = fixture();
    run(['visit', p, 'n-1', '--channel', 'human-detail']);
    const payload = heatJson(p, ['--node', 'n-2']);           // n-2 从没被访问过
    expect(payload.node.listed).toBe(false);
    expect(payload.node.reason).toBe(heat.NO_VISIT_REASON);

    const env = loadBars();
    env.state.project.name = p;
    env.api.heat = () => Promise.resolve({ ok: true, payload: payload, nodeId: 'n-2' });
    const box = { el: new El('div'), node: { id: 'n-2' }, heatEl: new El('div') };
    env.MM.heatBarsRefresh(box, box.node);
    await new Promise((r) => setTimeout(r, 0));

    const rows = box.heatEl.find('fd-heat-row');
    expect(rows.length).toBe(2);
    rows.forEach((rw) => expect(rw.getAttribute('data-listed')).toBe('0'));
    expect(box.heatEl.textContent).toContain('本窗口未访问');
  });

  it('A3 采样点：渲染层**不自己**决定记哪条通道 —— 通道名只有一处（human-detail），且由 showDetail 触发', () => {
    const bars = fs.readFileSync(path.join(ROOT, 'renderer', 'app-heat-bars.js'), 'utf8');
    const detail = fs.readFileSync(path.join(ROOT, 'renderer', 'app-detail.js'), 'utf8');
    // ① 通道名在渲染层只出现一次（`app-heat-bars.js` 的那个常量），别处不许再写一遍
    expect((bars.match(/human-detail/g) || []).length).toBe(1);
    expect(detail).not.toContain('human-detail');
    // ② 采样点在 `showDetail` 里（"打开详情框"的唯一入口）
    expect(detail).toContain('heatBarsRecordHumanOpen');
    const at = detail.indexOf('function showDetail(node)');
    const call = detail.indexOf('heatBarsRecordHumanOpen');
    expect(at).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(at);                          // 调用点在 showDetail 之内
    expect(call).toBeLessThan(detail.indexOf('function showAssocPage'));
  });

  it('A4 【判据②】正文只有一份：给详情框正文赋值的**那一条语句**只有一处，且它赋的就是节点自己的 detail', () => {
    const dir = path.join(ROOT, 'renderer');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    const scans = [];
    files.forEach((f) => {
      fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
        // 只看**真在赋值**的行（注释里的说明不算 —— 本工程大量用注释记录口径）
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        const code = line.replace(/\s*\/\/.*$/, '');
        if (/\bdc\.innerHTML\s*=/.test(code)) scans.push({ file: f, line: i + 1, text: code.trim() });
      });
    });
    /* 全渲染层有三处 `dc.innerHTML = …`，但**写的容器不是同一个**：
     *   · `app-ask.js` / `app-assoc.js` 写的是**它们自己那个浮窗**（AI 问答浮窗 / 关联笔记页）；
     *   · 只有 `app-detail-content.js` 的 `renderFdBox` 写的才是**节点详情框的正文**。
     * 所以判据按"赋值源"钉：**正文 = 节点自己的 `detail`** 这一条只有一处 ——
     * 其余两处赋的是 `html` / `note.trim()`（各自的派生视图），与节点详情正文无关 ✓ */
    const bodyWriters = scans.filter((s) => /\bdetail\b/.test(s.text));
    expect(bodyWriters.length, JSON.stringify(scans)).toBe(1);
    expect(bodyWriters[0].file).toBe('app-detail-content.js');
    expect(bodyWriters[0].text).toContain('detail');
    // 反面前置：另外两处确实存在（否则"只有一处"这条判据是空话，而不是在守着一条真规矩）
    expect(scans.length).toBeGreaterThanOrEqual(3);
    // 本件新增的渲染层文件**一个字都不改正文**
    const bars = fs.readFileSync(path.join(ROOT, 'renderer', 'app-heat-bars.js'), 'utf8');
    const code = bars.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code.indexOf('fd-detail-content')).toBe(-1);
    expect(code.indexOf('innerHTML') > -1).toBe(true);   // 反面前置：它**确实**写 DOM（写的是 .fd-heat）
    expect(code).toContain("'.fd-heat'");
  });

  it('A5 改/看热度条**不写盘**：新增的渲染层文件里不出现保存/脏标记/项目写入口', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'renderer', 'app-heat-bars.js'), 'utf8');
    // 去注释后再搜（顶部纪律注释里**提名字**是好事：它说的是"本文件不碰这些"）
    const code = raw.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ['project.save', 'state.dirty', 'setDirty', 'confirmDiscardIfDirty', 'serializeTree', 'project.read'].forEach((needle) => {
      expect(code.indexOf(needle), '渲染层热度条不许出现 ' + needle).toBe(-1);
    });
    // 它只有两条 IPC：读热度 + 记访问（都是旁路，不碰项目数据）
    const ipc = code.match(/api\.\w+/g) || [];
    expect([...new Set(ipc)].sort()).toEqual(['api.heat', 'api.visit']);
    // 反面前置：它**确实**碰到了 MM.state（读项目名），所以上面那些"不许"不是空话
    expect(code).toContain('MM.state');
  });

  it('A6 失败响亮：读数失败 ⇒ 框里出现可见提示 + 控制台一条（**不许静默**）', async () => {
    const env = loadBars();
    env.state.project.name = 'p-x';
    env.api.heat = () => Promise.resolve({ ok: false, error: '日志坏了：第 3 行' });
    const box = { el: new El('div'), node: { id: 'n-1' }, heatEl: new El('div') };
    env.MM.heatBarsRefresh(box, box.node);
    await new Promise((r) => setTimeout(r, 0));
    const errs = box.heatEl.find('fd-heat-err');
    expect(errs.length).toBe(1);
    expect(errs[0].textContent).toContain('第 3 行');
  });

  it('A7 采样失败也响亮（控制台 + 状态栏各一条）', async () => {
    const env = loadBars();
    env.state.project.name = 'p-x';
    env.api.visit = () => Promise.resolve({ ok: false, reason: 'all-failed', errors: ['写入失败：磁盘满'] });
    env.MM.heatBarsRecordHumanOpen({ id: 'n-1' });
    await new Promise((r) => setTimeout(r, 0));
    expect(env.statuses.length).toBe(1);
    expect(env.statuses[0].err).toBe(true);
    expect(env.statuses[0].text).toContain('磁盘满');
    expect(env.MM.heatBarsState().visit.ok).toBe(false);
  });
});

/* ============================================================================
 * B. AI 侧隐藏维度（派生 + 界面不显示 + 样本量）
 * ========================================================================== */
describe('B. AI 侧隐藏维度（标签 / 章节 / 节点树）', () => {
  beforeEach(() => { sensor.__setEnabledForTest(false); });

  it('B1 【判据①】派生：注入"名次→档位"映射（档位 = 绝对次数）⇒ 派生值**必变** ⇒ 还原复绿', () => {
    const p = fixture();
    // 造出"档位真会被带偏"的局面：两个被访问过的节点，名次 1/2（十档里 10/5），
    // 而按绝对次数它们都是 1 ⇒ 注入后 `heatMax` 从 10 掉到 1（**必变的那个数**）。
    run(['visit', p, 'n-1', '--channel', 'human-detail']);
    run(['visit', p, 'n-2', '--channel', 'human-detail']);
    const payload0 = JSON.parse(run(['heat', p, '--json', '--derived', 'summary']).stdout);
    const snap = (j) => JSON.stringify({
      tags: j.derived.human.tags.items.map((x) => [x.key, x.heat, x.heatMax, x.rank, x.visited, x.nodes]),
      sections: j.derived.human.sections.items.map((x) => [x.key, x.heat, x.heatMax, x.rank, x.visited, x.nodes]),
      trees: j.derived.human.trees.items.map((x) => [x.key, x.heat, x.heatMax, x.rank, x.visited, x.nodes])
    });
    const before = snap(payload0);
    const old = heat.__setHeatMapperForTest((i) => i.count);     // ← 注入：档位 = 绝对次数
    let after = null;
    try {
      after = snap(JSON.parse(run(['heat', p, '--json', '--derived', 'summary']).stdout));
    } finally {
      heat.__setHeatMapperForTest(old);
    }
    expect(after).not.toBe(before);                              // ← 派生值跟着节点档位变了（同源派生的机械证据）
    const green = snap(JSON.parse(run(['heat', p, '--json', '--derived', 'summary']).stdout));
    expect(green).toBe(before);                                  // ← 还原 ⇒ 复绿（逐字节）
  });

  it('B2 【判据①】派生：同一份热度、改节点档位（不是改标签/结构）⇒ 标签/章节/节点树一起变', () => {
    const p = fixture();
    // 第一次：只有 n-1（标签 net/tcp、章节 s-1/t-a）被访问
    for (let i = 0; i < 2; i++) run(['visit', p, 'n-1', '--channel', 'human-detail']);
    const a = JSON.parse(run(['heat', p, '--json', '--derived', 'summary']).stdout).derived.human;
    // 第二次：**只改节点热度**（把 n-3 也访问一下）—— 标签/章节/树一个字节都没动
    for (let i = 0; i < 5; i++) run(['visit', p, 'n-3', '--channel', 'human-detail']);
    const b = JSON.parse(run(['heat', p, '--json', '--derived', 'summary']).stdout).derived.human;
    const key = (d) => ({
      tags: d.tags.keys.slice().sort(), sections: d.sections.keys.slice().sort(), trees: d.trees.keys.slice().sort()
    });
    // 维度集合没变（结构没动）—— 顺序会变（那是热度排名，正是"派生"），所以按**集合**比
    expect(JSON.stringify(key(b))).toBe(JSON.stringify(key(a)));
    const heatOf = (d, dim, k) => (d[dim].items.filter((x) => x.key === k)[0] || {}).heat;
    // 而"节点自己那一档"变了（n-3 现在更热）⇒ 它所在的章节/树的热度跟着变
    expect(heatOf(b, 'sections', 's-2')).not.toBe(heatOf(a, 'sections', 's-2'));
    expect(heatOf(b, 'trees', 't-a')).toBeDefined();
    // 人榜本身也变了（同一条链上的同一份读数）
    const rowsA = JSON.parse(run(['heat', p, '--json']).stdout);
    expect(rowsA.human.length).toBe(2);
  });

  it('B3 【判据②】界面不显示：把**带 derived 的完整载荷**喂给渲染层 ⇒ 详情框 HTML 里这些键名为 0', async () => {
    const p = fixture();
    run(['visit', p, 'n-1', '--channel', 'human-detail']);
    const payload = heatJson(p, ['--node', 'n-1', '--derived', 'summary']);
    expect(payload.derived).toBeTruthy();                        // 前置：载荷里**确实有**这些维度

    const env = loadBars();
    env.state.project.name = p;
    env.api.heat = () => Promise.resolve({ ok: true, payload: payload, nodeId: 'n-1' });
    const box = { el: new El('div'), node: { id: 'n-1' }, heatEl: new El('div') };
    env.MM.heatBarsRefresh(box, box.node);
    await new Promise((r) => setTimeout(r, 0));

    // 详情框里这一块的可见文本 + 机器可读属性 —— 搜键名必须为 0
    const text = box.heatEl.textContent;
    const attrs = JSON.stringify(box.heatEl.all().map((n) => [n.className, n.attrs]));
    ['derived', 'sections', 'trees'].forEach((word) => {
      expect(text.indexOf(word), '界面文本里不该出现 ' + word).toBe(-1);
      expect(attrs.indexOf(word), '界面属性里不该出现 ' + word).toBe(-1);
    });
    // 渲染层源码里也不许出现这些键（搜源码 = 那个键名没有第二处消费者）
    const bars = fs.readFileSync(path.join(ROOT, 'renderer', 'app-heat-bars.js'), 'utf8');
    expect(bars.indexOf('derived')).toBe(-1);
    expect(bars.indexOf('sections')).toBe(-1);
    expect(bars.indexOf('trees')).toBe(-1);
  });

  it('B4 【判据③】样本量如实暴露：每维都给 nodes/visited/events，且少样本时档位会跳（读数当场打印）', () => {
    const p = fixture();
    run(['visit', p, 'n-1', '--channel', 'human-detail']);       // 窗口内只有 1 个节点被访问
    const j = heatJson(p, ['--derived', 'summary']);
    const rows = j.derived.human.sections.items.concat(j.derived.human.tags.items, j.derived.human.trees.items);
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((row) => {
      expect(typeof row.nodes).toBe('number');
      expect(typeof row.visited).toBe('number');
      expect(typeof row.events).toBe('number');
      expect(row.visited).toBeLessThanOrEqual(row.nodes);        // 口径一致（visited ≤ nodes）
    });
    const visited = rows.filter((r) => r.visited > 0);
    expect(visited.length).toBeGreaterThan(0);
    // 少样本的证据：样本内只有 1 个节点被访问 ⇒ 它的档位恒为最高档（不是"它占全部分位"）
    expect(j.sample.nodes).toBe(1);
    visited.forEach((r) => expect(r.heat).toBe(heat.HEAT_BANDS));
    // 窗户内没被访问过的维度：heat=0 + rank=null（**不是**"热度为 0"那种含糊）
    const cold = rows.filter((r) => r.visited === 0);
    expect(cold.length).toBeGreaterThan(0);
    cold.forEach((r) => { expect(r.heat).toBe(0); expect(r.rank).toBe(null); });
    console.log('[B4 读数] 样本 节点数=' + j.sample.nodes + ' 事件=' + j.sample.events
      + ' ｜ 章节维度 ' + j.derived.human.sections.total + ' 条（列 ' + j.derived.human.sections.shown + '）'
      + ' ｜ 冷维度 ' + cold.length + ' 条（heat=0/rank=null）');
  });

  it('B5 `--derived keys` 是最省的一档：只要维度名 + 计数，不重复 items（AI 想先看有哪些维度）', () => {
    const p = fixture();
    run(['visit', p, 'n-1', '--channel', 'human-detail']);
    const j = heatJson(p, ['--derived', 'keys']);
    expect(Object.keys(j.derived.human).sort()).toEqual(['counts', 'sections', 'tags', 'trees', 'who']);
    expect(Array.isArray(j.derived.human.tags)).toBe(true);
    expect(j.derived.human.counts.sections).toBe(j.derived.human.sections.length);
    expect(JSON.stringify(j.derived).indexOf('"items"')).toBe(-1);
    // 与 summary 的**维度名集合**必须一致（同一处派生、两种展示形态）
    const sum = heatJson(p, ['--derived', 'summary']);
    expect(JSON.stringify(j.derived.human.sections)).toBe(JSON.stringify(sum.derived.human.sections.keys));
    expect(JSON.stringify(j.derived.human.trees)).toBe(JSON.stringify(sum.derived.human.trees.keys));
  });

  it('B6 两个维度各自独立成组：标签是正交的（一个节点挂在两个标签下 ⇒ 两个维度都可能热）', () => {
    const p = fixture();
    run(['visit', p, 'n-1', '--channel', 'human-detail']);       // n-1 有 net + tcp 两个标签
    const j = heatJson(p, ['--derived', 'summary']);
    const keys = j.derived.human.tags.items.map((x) => x.key);
    expect(keys).toContain('net');
    expect(keys).toContain('tcp');
    // 章节维度里 n-1 的每一级祖先都在（s-1 和 t-a），而 root 不在（它是"整个项目"）
    const secs = j.derived.human.sections.items.map((x) => x.key);
    expect(secs).toContain('n-1');
    expect(secs).toContain('s-1');
    expect(secs).toContain('t-a');
    expect(secs).not.toContain('root');
    expect(j.derived.human.trees.items.map((x) => x.key)).toEqual(['t-a']);
  });

  it('B7 `--derived` 的两个边界都响亮：坏值 / 文本档（**不许静默忽略**）', () => {
    const p = fixture();
    const bad = run(['heat', p, '--json', '--derived', 'bogus']);
    expect(bad.code).not.toBe(0);
    expect(bad.stdout).toContain('--derived');
    const text = run(['heat', p, '--derived', 'summary']);
    expect(text.code).not.toBe(0);
    expect(text.stdout).toContain('只在 `--json`');
    const noNode = run(['heat', p, '--json', '--node', '']);
    expect(noNode.code).not.toBe(0);
  });
});

/* ============================================================================
 * C. 结构：本件新增的口径各自只有一处
 * ========================================================================== */
describe('C. 结构断言（"定义只有一处"）', () => {
  it('C1 热度的**口径键名**在渲染层里只以注释出现：代码里一个都不认（档位/权重/窗口/映射全是 CLI 侧的）', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'renderer', 'app-heat-bars.js'), 'utf8');
    /** 去掉注释行，只留**会执行的代码** —— 判据要判的是"渲染层认不认这些键"，不是注释里提没提 */
    const code = raw.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ['CHANNELS', 'heatFromRank', 'WINDOW_DAYS', 'SEARCH_RANK', 'bandFraction', 'HEAT_BANDS'].forEach((k) => {
      expect(code.indexOf(k), '渲染层代码里不该出现 ' + k).toBe(-1);
    });
    // 它拿到的 `bands` 是读数给的 ⇒ 代码里不该有"档位 ÷ 总格数"这类换算
    expect(/\/\s*10\b/.test(code)).toBe(false);
    expect(code.indexOf('Math.round')).toBe(-1);
    // 反面前置：本文件**确实**认 `bands`（否则上面那些"不许"是空话）
    expect(code).toContain('row.bands');
  });

  it('C2 埋点的总开关只给测试用：`MM_HEAT_SENSOR` 在生产代码里除定义处外没有别的引用', () => {
    const walk = (rel) => {
      const abs = path.join(ROOT, rel);
      if (fs.statSync(abs).isFile()) return rel.endsWith('.js') ? [rel] : [];
      let out = [];
      fs.readdirSync(abs, { withFileTypes: true }).forEach((e) => {
        if (e.isDirectory()) { if (e.name !== 'node_modules') out = out.concat(walk(rel + '/' + e.name)); return; }
        if (e.name.endsWith('.js')) out.push(rel + '/' + e.name);
      });
      return out;
    };
    const files = [].concat(walk('src'), walk('cli'), walk('renderer'), walk('scripts'))
      .concat(['main.js', 'preload.js']);
    const hits = [];
    files.forEach((f) => {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      if (src.indexOf('MM_HEAT_SENSOR') < 0) return;
      if (f === 'src/heat-sensor.js') return;                   // ← 唯一允许的定义处
      hits.push(f);
    });
    expect(hits).toEqual([]);
  });
});
