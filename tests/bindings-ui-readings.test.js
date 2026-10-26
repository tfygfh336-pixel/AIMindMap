/* ============================================================
 * tests/bindings-ui-readings.test.js — 【20261059】② 状态条读数：两个槽（"最后的" vs "最后有内容的"）
 * 运行：npx vitest run tests/bindings-ui-readings.test.js
 * ------------------------------------------------------------
 * 缺陷出处（本批实测，读数见 `.review/20261059-mtime与lastSync/probe-两个缺陷.log`）：
 *   `renderer/app-bindings.js` 的 `applyReadings` 里 `lastSync = synced` —— **单槽**。于是
 *   "♻ 接回 1 个"只活到下一次真同步为止，被后面的轮次一顶就没了（那一轮是
 *   `{added:0, modified:1, reconnected:0}`，而"接回 + 提议撤回"只写在前一轮）。
 *
 * ## 前提核对（实测后修正的地方，**别照抄任务书**）
 *   "一路 no-change 的轮次会把接回读数顶掉"这件事在**旧代码里本来就不成立**：
 *   `if (synced)` 只认 `status === 'synced'` 的行，而 no-change 轮的 status 是 `'no-change'` ⇒ 它压根不更新。
 *   真正发生的是**假 modified 轮**（= 缺陷① 的产物，status 就是 `'synced'`）把读数顶掉。
 *   ⇒ 本文件的判据不再依赖那个巧合：② 的判据改成**看数**（`added/modified/reconnected` 有没有一个非零），
 *     并且把"最近跑过的那一轮"单独存一槽 —— 两件事分得开，也才有判别力。
 *
 * ## 四条判据（每条都带**该红**的注入，注入实跑记录见 .review 的 inject-*.log）
 *   ②-a 先"接回 1 个"、再一路 no-change ⇒ 读到的**仍是**"接回 1 个"
 *        （该红：退回单槽 = 任何一轮都写 `lastSync` ⇒ 当场红）
 *   ②-b 连续两轮都有实质动作 ⇒ 读到**后一轮**（该红：改成"第一次有动作就锁住" ⇒ 红）
 *   ②-c 全零轮 ⇒ **不更新**那个"有意义"的槽（该红：无条件更新 ⇒ 红）
 *   ②-d 切项目 ⇒ 不许显示上一个项目的读数（该红：去掉项目判定 ⇒ 红）
 *
 * ## ⚠️ 为什么自己搭一个假 DOM（而不用 jsdom）
 *   本工程没有 jsdom 依赖，而**加一个依赖**不是本件能做的决定（与 `tests/heat-bars.test.js` 同一个理由）。
 *   `renderer/app-bindings.js` 只用到极小的一块 DOM（getElementById / style / setAttribute / textContent），
 *   所以这里给一个**最小 DOM 桩**，并把**真实模块文件**（不是复制一份）加载进来跑 ——
 *   判据因此是对真实现的（改实现就红），不是对桩的。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_FILE = path.join(ROOT, 'renderer', 'app-bindings.js');
const SRC = fs.readFileSync(SRC_FILE, 'utf8');

/* ============================================================================
 * 最小 DOM 桩（只实现 `renderer/app-bindings.js` 用到的那一块）
 * ========================================================================== */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.style = {};
    this.className = '';
    this._text = '';
    this.disabled = false;
    this.title = '';
  }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener() { /* 本文件不点按钮：只验读数 */ }
  querySelector() { return null; }
}

/** 状态条 / 面板要用到的那几个 id（其余 getElementById 一律 null ⇒ 那段代码自己会跳过） */
const IDS = ['bind-bar', 'bind-bar-text', 'bind-btn-toggle', 'bind-btn-sync', 'bind-btn-unbind',
  'bind-btn-pending', 'bind-pending', 'bind-pending-list', 'bind-pending-head', 'bind-pending-confirm',
  'bind-pending-later', 'bind-banner', 'bind-banner-text', 'btn-bind-workspace'];

const BINDING_ROW = {
  binding: 'wb-1', dir: 'D:/notes', mode: 'flat', status: 'watching', active: true,
  scanned: 4, kept: 4, files: 4, added: 0, modified: 0, containers: 0,
  pending: 0, pendingBefore: 0, unconverted: 0, reconnected: 0, reconnectedList: [],
  unchanged: 4, changedKeys: [], lastSyncAt: '2026-10-30T00:00:00.000Z'
};

/**
 * 装一个"渲染层运行环境"：`window.MM` + 假 document，然后用**真文件**加载 `app-bindings.js`。
 * `holder.project` 是可变的 —— 切项目就改它（`MM.getState()` 每次现读）。
 */
function loadUi(projectName) {
  const els = {};
  IDS.forEach((id) => { els[id] = new El('div'); });
  els['bind-bar'].style.display = 'none';
  const holder = { project: projectName };
  const doc = {
    readyState: 'complete',
    getElementById: (id) => (els[id] || null),
    createElement: (t) => new El(t),
    addEventListener: () => {}
  };
  const statuses = [];
  const MM = {
    getState: () => ({ project: { name: holder.project } }),
    setStatus: (t, isErr) => statuses.push({ text: String(t), err: !!isErr }),
    requestReread: () => {}
  };
  /* 探针报告按**当时的**项目名现造：切项目之后的刷新（`bindRefresh`）拿到的就是**新项目**的报告 ——
   * 这正是真实现场（`refreshBar` → `app:bind-probe`）。若这里写死一个 'P'，切项目后 `renderBar` 会走
   * "没有绑定行"那条早退分支、把属性全清掉 ⇒ ②-d 会**假绿**（连带那条注入也抓不到）。 */
  const makeReport = () => ({
    project: holder.project, dryRun: true, bindings: [Object.assign({}, BINDING_ROW)], sync: []
  });
  const win = {
    MM, document: doc, console,
    desktop: {
      app: {
        bindProbe: () => Promise.resolve({ ok: true, report: makeReport() }),
        bindCmd: () => Promise.resolve({ ok: true, report: makeReport() })
      },
      project: { peek: () => Promise.resolve({ ok: false, error: '本文件不读盘' }) },
      onBindSynced: () => {},
      onProjectDiskChange: () => {}
    }
  };
  const ctx = {
    window: win, document: doc, console,
    Date, Number, String, Object, Array, JSON, Promise, Math, Error, isFinite, parseInt, parseFloat,
    setTimeout: () => 0, clearTimeout: () => {}
  };
  vm.runInNewContext(SRC, ctx, { filename: 'renderer/app-bindings.js' });
  return { MM, els, holder, statuses };
}

/* 引擎报告里那一行（`bind-sync --json` 的 `sync[0]`）的三种真实形状 */
const R_RECONNECT = {
  status: 'synced', added: 0, modified: 1, pending: 0, unconverted: 0, unchanged: 3,
  reconnected: 1, reconnectedList: [{ rel: 'f.md', nodeId: 'n-f', from: 'pending', proposalWithdrawn: true }],
  lastSyncAt: '2026-10-30T00:00:10.000Z'
};
const R_MODIFIED = {   // 缺陷①造出来的那种假 modified 轮（内容没变却整轮重跑）
  status: 'synced', added: 0, modified: 1, pending: 0, unconverted: 0, unchanged: 3,
  reconnected: 0, reconnectedList: [], lastSyncAt: '2026-10-30T00:00:20.000Z'
};
const R_NOCHANGE = {   // 一路 no-change：三个数全零
  status: 'no-change', added: 0, modified: 0, pending: 0, unconverted: 0, unchanged: 4,
  reconnected: 0, reconnectedList: [], lastSyncAt: '2026-10-30T00:00:10.000Z'
};
const R_CONFIRMED = {  // 只处理了确认删除：树动了，但 added/modified/reconnected 三个数都是 0
  status: 'confirmed', added: 0, modified: 0, pending: 0, unconverted: 0, unchanged: 4,
  reconnected: 0, reconnectedList: [], dropped: 1, lastSyncAt: '2026-10-30T00:00:30.000Z'
};

const payload = (row, project) => ({
  project: project || 'P', why: 'fs.watch',
  report: { project: project || 'P', dryRun: true, bindings: [Object.assign({}, BINDING_ROW)], sync: [row] },
  changedKeys: [], addedKeys: [], removedKeys: [], modifiedKeys: [], labels: {}
});
const barText = (ui) => String((ui.els['bind-bar-text'] && ui.els['bind-bar-text'].textContent) || '');
const attr = (ui, k) => ui.els['bind-bar'].getAttribute(k);

/* ============================================================================
 * ②-a 接回读数不被后面的 no-change 轮顶掉
 * ========================================================================== */
describe('②-a 先"接回 1 个"、再一路 no-change ⇒ 读到的仍是"接回 1 个"', () => {
  it('meaningful 槽保留 reconnected=1；状态条仍说"接回"；且**标明**这是上一轮的读数', async () => {
    const ui = loadUi('P');
    await Promise.resolve();
    ui.MM.onBindSynced(payload(Object.assign({}, R_RECONNECT)));
    expect(ui.MM.bindState().lastSync.reconnected).toBe(1);

    ui.MM.onBindSynced(payload(Object.assign({}, R_NOCHANGE)));
    const st = ui.MM.bindState();
    expect(st.lastSync, '"有意义"的槽不许被 no-change 轮换掉').toMatchObject({ reconnected: 1, modified: 1 });
    expect(st.lastRun, '但"最近跑过的那一轮"要如实记成 no-change（两个槽真的分开）').toMatchObject({ status: 'no-change' });
    expect(attr(ui, 'data-bind-reconnected'), '机器可读的那一份也要保住').toBe('1');
    expect(attr(ui, 'data-bind-modified')).toBe('1');
    expect(barText(ui)).toContain('接回原节点 1 个');
    /* 不许拿上一轮的数冒充"本次"：文案要说清这是"上次有动作"，并且点名"最近一轮无变化" */
    expect(attr(ui, 'data-bind-readings'), '这批数不是最近一轮的').toBe('stale');
    expect(barText(ui)).toContain('上次有动作');
    expect(barText(ui)).toContain('最近一轮无变化');
  });

  it('连续两次 no-change 之后仍读得到；而"只确认删除"的轮同样不许把它顶掉', async () => {
    const ui = loadUi('P');
    await Promise.resolve();
    ui.MM.onBindSynced(payload(Object.assign({}, R_RECONNECT)));
    ui.MM.onBindSynced(payload(Object.assign({}, R_NOCHANGE)));
    ui.MM.onBindSynced(payload(Object.assign({}, R_CONFIRMED)));
    const st = ui.MM.bindState();
    expect(st.lastSync.reconnected).toBe(1);
    expect(st.lastRun.status).toBe('confirmed');
    expect(barText(ui)).toContain('接回原节点 1 个');
    expect(barText(ui), '文案要说出"最近这一轮只是确认了删除"').toContain('只处理了确认删除');
  });
});

/* ============================================================================
 * ②-b 连续两轮都有实质动作 ⇒ 读到后一轮
 * ========================================================================== */
describe('②-b 连续两轮都有实质动作 ⇒ 读到**后一轮**', () => {
  it('先新增 2 个、再改 3 个 ⇒ 状态条那批数是后一轮的', async () => {
    const ui = loadUi('P');
    await Promise.resolve();
    ui.MM.onBindSynced(payload(Object.assign({}, R_RECONNECT, { added: 2, modified: 0, reconnected: 0, reconnectedList: [] })));
    expect(ui.MM.bindState().lastSync).toMatchObject({ added: 2, reconnected: 0 });
    ui.MM.onBindSynced(payload(Object.assign({}, R_MODIFIED, { added: 0, modified: 3 })));
    const st = ui.MM.bindState();
    expect(st.lastSync, '"最后有内容的"就是后一轮（不是"第一次有动作"）').toMatchObject({ added: 0, modified: 3 });
    expect(attr(ui, 'data-bind-added')).toBe('0');
    expect(attr(ui, 'data-bind-modified')).toBe('3');
    expect(attr(ui, 'data-bind-readings'), '这批数就是最近一轮的').toBe('fresh');
  });
});

/* ============================================================================
 * ②-c 全零轮不更新"有意义"的槽
 * ========================================================================== */
describe('②-c 全零轮 ⇒ 不更新那个"有意义"的槽', () => {
  it('先有动作、再全零：那个槽逐字段不变（比对象内容，不比引用）', async () => {
    const ui = loadUi('P');
    await Promise.resolve();
    ui.MM.onBindSynced(payload(Object.assign({}, R_RECONNECT)));
    const before = JSON.stringify(ui.MM.bindState().lastSync);
    ui.MM.onBindSynced(payload(Object.assign({}, R_NOCHANGE, { added: 0, modified: 0, reconnected: 0 })));
    expect(JSON.stringify(ui.MM.bindState().lastSync), '全零轮不许写进"有意义"的槽').toBe(before);
  });

  it('**第一轮就是全零** ⇒ 那个槽仍是 null（状态条说"本次 —"，不编一个 +0 改 0 出来）', async () => {
    const ui = loadUi('P');
    await Promise.resolve();
    ui.MM.onBindSynced(payload(Object.assign({}, R_NOCHANGE)));
    const st = ui.MM.bindState();
    expect(st.lastSync).toBe(null);
    expect(st.lastRun).toMatchObject({ status: 'no-change' });
    expect(attr(ui, 'data-bind-readings')).toBe('none');
    expect(attr(ui, 'data-bind-added')).toBe('');
    expect(barText(ui)).toContain('本次 —');
  });
});

/* ============================================================================
 * ②-d 切项目：不许显示上一个项目的读数
 * ========================================================================== */
describe('②-d 切项目 ⇒ 上一个项目的 +N改M / 接回 不许留在状态条上', () => {
  it('项目 P 接回 1 个 ⇒ 切到项目 Q（并刷新探针）⇒ 状态条读不到它（槽里的原始记录仍在，证据要能取回）', async () => {
    const ui = loadUi('P');
    await Promise.resolve();
    ui.MM.onBindSynced(payload(Object.assign({}, R_RECONNECT), 'P'));
    expect(barText(ui)).toContain('接回原节点 1 个');

    ui.holder.project = 'Q';                  // ← 切项目（MM.getState() 现读）
    /* 切项目之后的常规刷新：探针按**新项目**返回报告 ⇒ `renderBar` 走的是**完整分支**
     * （有绑定行），所以这里能不能读不到旧读数，只取决于项目判定这一条。 */
    await ui.MM.bindRefresh();
    const st = ui.MM.bindState();
    expect(st.probe.project, '夹具前提：探针报告已经是新项目的（否则测不到项目判定）').toBe('Q');
    expect(st.lastSyncProject, '槽里记的是哪个项目的读数').toBe('P');
    expect(attr(ui, 'data-bind-reconnected'), '别的项目的接回读数不许出现在这里').toBe('');
    expect(attr(ui, 'data-bind-added')).toBe('');
    expect(attr(ui, 'data-bind-readings')).toBe('none');
    expect(barText(ui)).not.toContain('接回原节点');
    expect(barText(ui), '也不许拿上一个项目的 +N改M 冒充本项目').not.toContain('上次有动作');
  });
});

/* ============================================================================
 * 结构判据：两件事只有一处实现（不然"改了等于没改"）
 * ========================================================================== */
describe('结构：两个槽 + 一条判据，都只有一处实现', () => {
  it('`substantialReading` 恰好定义一次；`lastSync` 只在 applyReadings 里被赋值一次', () => {
    const defs = (SRC.match(/function substantialReading\(/g) || []).length;
    expect(defs, '判据只有一处实现').toBe(1);
    // 声明一处 + applyReadings 里一处 ⇒ 恰好两处（多一处就是"第二份单槽"又长出来了）
    const assigns = (SRC.match(/\blastSync\s*=/g) || []).length;
    expect(assigns, '`lastSync` 的赋值点：声明 + applyReadings 各一处').toBe(2);
    expect(SRC).toContain('lastRun = latest');
    expect(SRC, '机器可读面：这批数是"最近一轮"的还是"上次有动作"的').toContain("data-bind-readings");
    expect(SRC).toContain("data-bind-last-run");
    // 两个槽都要带项目名（串页的唯一防线）
    expect(SRC).toContain('lastSyncProject');
    expect(SRC).toContain('lastRunProject');
  });

  it('状态条的读数**只**从 `lastSyncHere()` 取（不许有地方直接读裸 `lastSync` 去显示）', () => {
    const body = SRC.slice(SRC.indexOf('function renderBar'), SRC.indexOf('/* ================= ④ 待确认的删除'));
    expect(body.length).toBeGreaterThan(500);
    expect(body).toContain('lastSyncHere()');
    /* 只看**代码**：注释里点名 `lastSync` 是解释（"为什么不直接读它"），不算实现。
     * 去注释后仍然出现裸 `lastSync` ⇒ 有人绕过了项目判定/两槽判定，直接把单槽读出来显示。 */
    const code = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    expect(/\blastSync\b(?!Here)/.test(code), '状态条正文里不许出现裸 lastSync').toBe(false);
  });
});
