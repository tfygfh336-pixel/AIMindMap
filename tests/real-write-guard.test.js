/* ============================================================
 * tests/real-write-guard.test.js —— 「真实数据零写入」三档归因的契约（纯函数）
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 为什么这份判据值得有单测：它是**唯一能把"环境问题"与"产品缺陷"分开的地方** ——
 *   判错成"红" ⇒ 同机有人开着应用就必然假红（长期挂红的下场是连真红也不看）；
 *   判错成"通过" ⇒ 真实数据被写坏也看不见（本工程最重的损害类别：静默）。
 * 所以这里锁四件事：
 *   ① **有本次自己的证据 ⇒ 一律判红**（别人的写入不许成为免责盾牌）；
 *   ② **有"不是本次写的"正证据 ⇒ 只到"本次没验"**（不判红，也**不许**报成通过）；
 *   ③ 采不到真值 ⇒ 判红（不许把"没验"报成"通过"）；
 *   ④ 判别力：把旧实现（任何差异一律判红）放回同一组夹具上 ⇒ 那组"他人写入"夹具上**必红** ✓
 *      （这才是本批降档真正改变的东西）；同一组里的"本次自己写"夹具在**新**实现下**仍然红** ✓。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const guard = require('../scripts/smoke/real-write-guard.js');

const OUR = 4321;
const T0 = Date.parse('2026-10-16T10:00:00.000Z');   // 窗口开始（快照那一刻）
const T1 = Date.parse('2026-10-16T10:05:00.000Z');   // 窗口结束（复核那一刻）
const MID = Date.parse('2026-10-16T10:02:00.000Z');  // 窗口正中（本进程写盘会落在这里）
const env = (over) => Object.assign({
  ourPid: OUR, windowStartMs: T0, windowEndMs: T1, othersAlive: [], probeError: null
}, over || {});

describe('① 有本次自己的证据 ⇒ 判红（别人的写入不许当免责盾牌）', () => {
  it('写入者 pid = 本进程 ⇒ 即便是 .ui-state.json 也判红（这是"零写入"被抓现行的那一档）', () => {
    const r = guard.classifyRealWrites([
      { rel: 'comnet/.ui-state.json', kind: 'changed', writerPid: OUR, mtimeMs: MID, stampMs: MID }
    ], env());
    expect(r.verdict).toBe('leak');
    expect(r.counts.ours).toBe(1);
  });

  it('没有任何归因证据（无 pid、时间戳在窗口内、也没有别的活实例）⇒ 一律按本次算 ⇒ 红', () => {
    const r = guard.classifyRealWrites([
      { rel: '_leak-inject-probe.json', kind: 'added', mtimeMs: MID }
    ], env());
    expect(r.verdict).toBe('leak');
    expect(r.items[0].why).toContain('按本次算');
  });

  it('**混合**：一处本次写 + 一处他人写 ⇒ 仍然判红（他人那一处不许把本次那处洗掉）', () => {
    const r = guard.classifyRealWrites([
      { rel: '_leak-inject-probe.json', kind: 'added', mtimeMs: MID },
      { rel: 'comnet/.ui-state.json', kind: 'changed', writerPid: 999999, mtimeMs: MID }
    ], env());
    expect(r.verdict).toBe('leak');
    expect(r.counts.ours).toBe(1);
    expect(r.counts.foreign).toBe(1);
    expect(r.reason).toContain('另有 1 处属他人写入');
  });

  it('⚠️ 边界（如实登记）：有别的活实例时，**没有归因证据**的那一处也只能到"未验" ——', () => {
    // 这一档是"免责"而不是"证明"：别人在写的时候，若本次**也**写了没有 pid 证据的文件，
    // 这一层确实看不出来（所以它只到"本次没验"，绝不报成通过，并给出"关掉那个实例再跑"的前提）。
    const r = guard.classifyRealWrites([
      { rel: '_leak-inject-probe.json', kind: 'added', mtimeMs: MID }
    ], env({ othersAlive: [999999] }));
    expect(r.verdict).toBe('unverified');
  });
});

describe('② 有"不是本次写的"正证据 ⇒ 只到"本次没验"（不判红，也不当通过）', () => {
  it('`.ui-state.json` 的 uiPid 不是本进程（**别人开着的应用写的**）⇒ 本次没验', () => {
    const r = guard.classifyRealWrites([
      { rel: 'comnet/.ui-state.json', kind: 'changed', writerPid: 777, mtimeMs: MID, stampMs: MID }
    ], env());
    expect(r.verdict).toBe('unverified');
    expect(r.items[0].why).toContain('不是**本进程');
    expect(r.counts.foreign).toBe(1);
  });

  it('写入者 pid 已不存在也一样算"他人"（判据只认"不等于本进程"，不认活性）', () => {
    const r = guard.classifyRealWrites([
      { rel: '卖点讨论/.ui-state.json', kind: 'changed', writerPid: 999999, mtimeMs: MID }
    ], env());
    expect(r.verdict).toBe('unverified');
  });

  it('时间戳**早于运行窗口**（备份/同步工具保留时间戳地搬进来）⇒ 本次没验', () => {
    const r = guard.classifyRealWrites([
      { rel: 'comnet/comnet.json', kind: 'changed', mtimeMs: T0 - 3600000 }
    ], env());
    expect(r.verdict).toBe('unverified');
    expect(r.items[0].why).toContain('早于本次运行窗口开始');
  });

  it('时间戳**晚于复核时刻**（本进程写不出"未来"的文件）⇒ 本次没验', () => {
    const r = guard.classifyRealWrites([
      { rel: 'comnet/comnet.json', kind: 'added', mtimeMs: T1 + 60000 }
    ], env());
    expect(r.verdict).toBe('unverified');
    expect(r.items[0].why).toContain('晚于本次复核时刻');
  });

  it('没有归因证据、但探针发现**另一个活着的界面实例** ⇒ 本次没验（并给出重跑前提）', () => {
    const r = guard.classifyRealWrites([
      { rel: 'comnet/comnet.json', kind: 'changed', mtimeMs: MID }
    ], env({ othersAlive: [777] }));
    expect(r.verdict).toBe('unverified');
    expect(r.items[0].why).toContain('无法归因到本次');
    expect(guard.summaryLines(r).join('\n')).toContain('关掉同机正在使用本应用的实例');
  });

  it('**没有**活实例时不免责（env.othersAlive 空 ⇒ 上面同一夹具就判红）', () => {
    const r = guard.classifyRealWrites([
      { rel: 'comnet/comnet.json', kind: 'changed', mtimeMs: MID }
    ], env());
    expect(r.verdict).toBe('leak');
  });
});

describe('③ 采不到真值 / 没变化', () => {
  it('干净 ⇒ ok（且一行都不该出现"没验"字样）', () => {
    const r = guard.classifyRealWrites([], env());
    expect(r.verdict).toBe('ok');
    expect(guard.summaryLines(r).join('\n')).not.toContain('本次没验');
  });

  it('探针自己失败 ⇒ error ⇒ 判红（采不到真值不能自称已校验）', () => {
    const r = guard.classifyRealWrites([], env({ probeError: 'readdir 失败' }));
    expect(r.verdict).toBe('error');
    expect(r.reason).toContain('采不到真值 = 红');
  });
});

describe('环境准入探针（独立于产品链路：只读真实目录里的旁挂文件）', () => {
  const uiState = (pid) => JSON.stringify({ schemaVersion: 1, project: 'comnet', dirty: false,
    uiPid: pid, updatedAt: new Date(MID).toISOString() });

  it('别人的实例活着 ⇒ foreignAlive 报出它的 pid；本进程自己不算"别人"', () => {
    const p = guard.probeForeignWriters([
      { project: 'comnet', stateText: uiState(777) },
      { project: '卖点讨论', stateText: uiState(OUR) }
    ], { ourPid: OUR, isAlive: (pid) => pid === 777 });
    expect(p.foreignAlive).toEqual([777]);
    expect(p.writers.length).toBe(2);
    expect(p.writers.filter((w) => w.foreign).length).toBe(1);
  });

  it('别人的实例已退出 ⇒ 不进 foreignAlive（它已经不写了）', () => {
    const p = guard.probeForeignWriters([
      { project: 'comnet', stateText: uiState(777) }
    ], { ourPid: OUR, isAlive: () => false });
    expect(p.foreignAlive).toEqual([]);
  });

  it('没有旁挂文件 / 内容坏 ⇒ 不假装"有人"、也不抛（坏内容只记一行读数）', () => {
    const p = guard.probeForeignWriters([
      { project: 'comnet', stateText: null },
      { project: '坏', stateText: '{不是 JSON' }
    ], { ourPid: OUR, isAlive: () => true });
    expect(p.writers).toEqual([]);
    expect(p.foreignAlive).toEqual([]);
    expect(p.errors.length).toBe(1);
  });
});

describe('三态在汇总行里同时可见（"没验"不许被读成"过了"）', () => {
  it('未验证那一档必须**响亮**：带"本次没验"字样 + 不当成产品缺陷 + 给出重跑前提', () => {
    const r = guard.classifyRealWrites([
      { rel: 'comnet/.ui-state.json', kind: 'changed', writerPid: 777, mtimeMs: MID }
    ], env());
    const text = guard.summaryLines(r, { probe: { writers: [{ project: 'comnet', uiPid: 777, alive: true, foreign: true }], foreignAlive: [777], errors: [] } }).join('\n');
    expect(text).toContain('本次没验');
    expect(text).toContain('不计产品缺陷');
    expect(text).toContain('不当通过');
    expect(text).toContain('不许');
    expect(text).toContain('环境探针');
    expect(text).toContain('改=1 新增=0 删除=0');
  });

  it('判红那一档也把"本次证据 / 他人证据"两个现算数摆出来（混合夹具：一处本次 + 一处他人）', () => {
    const r = guard.classifyRealWrites([
      { rel: '_leak-inject-probe.json', kind: 'added', mtimeMs: MID },
      { rel: 'comnet/.ui-state.json', kind: 'changed', writerPid: 777, mtimeMs: MID }
    ], env());
    const text = guard.summaryLines(r).join('\n');
    expect(r.verdict).toBe('leak');
    expect(text).toContain('本次证据 1');
    expect(text).toContain('他人证据 1');
    expect(text).toContain('判红（有本次写入的证据）');
  });

  it('有别的活实例时，**没有归因证据**的那一处也只能到"未验"（边界：免责而非证明）', () => {
    const r = guard.classifyRealWrites([
      { rel: 'comnet/comnet.json', kind: 'changed', mtimeMs: MID }
    ], env({ othersAlive: [777] }));
    expect(r.verdict).toBe('unverified');
    expect(guard.summaryLines(r).join('\n')).toContain('无法归因到本次');
  });
});

/* ============================================================================
 * 效率批 3 增补：ⓓ **批登记式归因**（四态 + 判别力）
 * 背景：CLI/代理批写 `projects/**` 没有界面实例可归因（无 `.ui-state.json`）⇒ 一律保守判红
 * ⇒ "并行书批每写一次，全链就红一次" ✗。修法 = 登记式：写者按「先登记后写」把自报登记
 * （pid + 批名 + 时间窗）落进 `projects/.writers/<批id>.json`，守卫读登记表归因。
 * 四态（档数 ≥ 状态数，B4b）：**自己写 ⇒ 红** · **在册他人 ⇒ 本次没验** ·
 * **未登记的陌生人 ⇒ 红** · **采不到（探针失败/坏条目）⇒ 红**。
 * 判别力：把登记表**删掉 / 过期** ⇒ 同一夹具**恢复判红** ✓（没有"登记在场"这个证据就没有豁免）。
 * ========================================================================== */
describe('ⓓ 批登记式归因：四态', () => {
  const reg = (id, pid, over) => Object.assign({ id, pid, name: '书批：' + id,
    windowStartMs: T0 - 60000, windowEndMs: T1 + 60000, foreign: pid !== OUR, alive: true }, over || {});

  it('① 自己写 ⇒ **仍红**：pid = 本进程的在册批不许给本进程免责（登记不是自洗工具 ✗）', () => {
    const r = guard.classifyRealWrites([
      { rel: 'book-x/chapter.md', kind: 'changed', mtimeMs: MID }
    ], env({ registeredBatches: [reg('self-reg', OUR)] }));
    expect(r.verdict).toBe('leak');
    expect(r.items[0].why).toContain('不许给本进程免责');
    expect(r.counts.inRegistry).toBe(0);
  });

  it('② 在册他人 ⇒ **本次没验（在册批：<id>）**：窗口盖住写入时刻、pid 不是本进程 ⇒ 归给该批', () => {
    const r = guard.classifyRealWrites([
      { rel: 'book-x/chapter.md', kind: 'changed', mtimeMs: MID }
    ], env({ registeredBatches: [reg('book-batch-a', 777)] }));
    expect(r.verdict).toBe('unverified');
    expect(r.items[0].why).toContain('在册批');
    expect(r.items[0].why).toContain('book-batch-a');
    expect(r.counts.inRegistry).toBe(1);
    expect(r.registryIds).toEqual(['book-batch-a']);
    // 响亮度：汇总行必须带"本次没验（在册批：…）"字样（不许把没验读成过了）
    const text = guard.summaryLines(r, { registry: { batches: [reg('book-batch-a', 777)], errors: [] } }).join('\n');
    expect(text).toContain('本次没验（在册批：book-batch-a）');
    expect(text).toContain('不计成产品缺陷');
  });

  it('③ 未登记的陌生人 ⇒ **红**（登记表为空 / 窗口没盖住写入时刻 / 条目已过期，三个形状都判红）', () => {
    // a) 登记表删掉了（空）
    const a = guard.classifyRealWrites([{ rel: 'book-x/chapter.md', kind: 'changed', mtimeMs: MID }], env());
    expect(a.verdict).toBe('leak');
    // b) 登记在场但**窗口没盖住**这一笔（先写后登记 = 违反"先登记后写"，写者自己的责任）
    const b = guard.classifyRealWrites([{ rel: 'book-x/chapter.md', kind: 'changed', mtimeMs: MID }],
      env({ registeredBatches: [reg('late-reg', 777, { windowStartMs: T1 + 3600000, windowEndMs: T1 + 7200000 })] }));
    expect(b.verdict).toBe('leak');
    // c) 登记在场但已过期（窗口外自动失效 ⇒ 不留永久豁免）
    const c = guard.classifyRealWrites([{ rel: 'book-x/chapter.md', kind: 'changed', mtimeMs: MID }],
      env({ registeredBatches: [reg('stale-reg', 777, { expired: true, windowStartMs: T0 - 7200000, windowEndMs: T0 - 3600000 })] }));
    expect(c.verdict).toBe('leak');
    expect(c.items[0].why).toContain('按本次算');
  });

  it('④ 采不到 ⇒ **红**：探针失败照旧 error；**坏条目**（坏 JSON / 字段不全 / 窗口超上界）不给豁免', () => {
    const err = guard.classifyRealWrites([{ rel: 'x', kind: 'changed', mtimeMs: MID }],
      env({ registeredBatches: [reg('good', 777)], probeError: 'readdir 失败' }));
    expect(err.verdict).toBe('error');   // 采不到真值 = 红（豁免救不了采不到 ✗）
    const bad = guard.classifyRealWrites([{ rel: 'book-x/chapter.md', kind: 'changed', mtimeMs: MID }],
      env({ registeredBatches: [
        { id: 'broken', pid: 777, name: 'x', windowStartMs: '不是数字', windowEndMs: T1 }
      ] }));
    expect(bad.verdict).toBe('leak');    // 字段不全 ⇒ 按无效处理 ⇒ 恢复判红
  });

  it('**混合**：一处归给在册批 + 一处陌生人 ⇒ 仍然判红（在册批不许把陌生人那处洗掉）', () => {
    // 批窗口只盖住前一笔（[T0−1min, MID+30s]）；后一笔在批窗口**外**、仍在运行窗口**内** ⇒ 陌生人。
    // （若批窗口盖住整段运行窗，陌生人同刻的写入本来也会被归给批 —— 那是 ⓓ"免责非证明"的边界，
    //  与 ⓒ 同档：它只降档为"没验"、绝不把"陌生人"判成"本次写" ✗。）
    const r = guard.classifyRealWrites([
      { rel: 'book-x/a.md', kind: 'changed', mtimeMs: MID },
      { rel: '_stranger-probe.json', kind: 'added', mtimeMs: MID + 60000 }
    ], env({ registeredBatches: [reg('book-batch-a', 777, { windowEndMs: MID + 30000 })] }));
    expect(r.verdict).toBe('leak');
    expect(r.counts.inRegistry).toBe(1);
    expect(r.counts.ours).toBe(1);
    expect(r.items[0].verdict).toBe('unverified');
    expect(r.items[1].verdict).toBe('leak');
  });

  it('登记的**优先级**：本进程 pid 的登记压过他人的（保守方向是红）', () => {
    const r = guard.classifyRealWrites([{ rel: 'x', kind: 'changed', mtimeMs: MID }],
      env({ registeredBatches: [reg('ours-first', OUR), reg('theirs', 777)] }));
    expect(r.verdict).toBe('leak');
    expect(r.items[0].why).toContain('不许给本进程免责');
  });
});

describe('ⓓ parseWriterRegistry：登记表校验（唯一口径；坏条目记读数、不给豁免）', () => {
  const ok = (pid, over) => JSON.stringify(Object.assign({
    schemaVersion: 1, batchId: 'b', pid, batchName: '书批：b',
    windowStartMs: T0 - 60000, windowEndMs: T1 + 60000, registeredAt: new Date(MID).toISOString()
  }, over || {}));

  it('合法条目：foreign = pid !== 本进程；活性不进免责条件（只进打印）；expired 按窗口现判', () => {
    const r = guard.parseWriterRegistry([
      { id: 'a', text: ok(777) },
      { id: 'ours', text: ok(OUR) },
      { id: 'dead', text: ok(778, { windowStartMs: T0 - 7200000, windowEndMs: T0 - 3600000 }) }
    ], { ourPid: OUR, isAlive: (p) => p === 777, nowMs: T1 });
    expect(r.errors).toEqual([]);
    expect(r.batches).toHaveLength(3);
    const byId = {};
    r.batches.forEach((b) => { byId[b.id] = b; });
    expect(byId.a.foreign).toBe(true);
    expect(byId.a.alive).toBe(true);
    expect(byId.ours.foreign).toBe(false);
    expect(byId.dead.expired).toBe(true);      // 窗口外 ⇒ 自动失效
    expect(byId.dead.alive).toBe(false);       // 活性只进读数，不进免责条件
  });

  it('坏 JSON / 缺 batchName / windowStart > windowEnd / 窗口超 30 天 ⇒ 全部按无效处理（errors 记读数）', () => {
    const r = guard.parseWriterRegistry([
      { id: 'e1', text: '{不是 JSON' },
      { id: 'e2', text: JSON.stringify({ pid: 777, windowStartMs: T0, windowEndMs: T1 }) },
      { id: 'e3', text: ok(777, { windowStartMs: T1, windowEndMs: T0 }) },
      { id: 'e4', text: ok(777, { windowStartMs: T0, windowEndMs: T0 + 31 * 24 * 3600000 }) },
      { id: 'e5', text: null }
    ], { ourPid: OUR, isAlive: () => true });
    expect(r.batches).toEqual([]);
    expect(r.errors).toHaveLength(5);
    r.errors.forEach((x) => expect(x).toContain('不给豁免'));
  });
});

describe('ⓓ 汇总行：在册批台账必须可见（B8：豁免计入输出、坏条目响亮）', () => {
  it('打印每个在册批（id/pid/批名/窗口/过期），坏条目逐条记读数', () => {
    const text = guard.summaryLines(
      guard.classifyRealWrites([], env()),
      { registry: { batches: [
        { id: 'book-batch-a', pid: 777, name: '书批：甲', windowStartMs: T0, windowEndMs: T1, foreign: true, alive: true, expired: false },
        { id: 'stale', pid: 778, name: '书批：乙', windowStartMs: T0 - 7200000, windowEndMs: T0 - 3600000, foreign: true, alive: false, expired: true }
      ], errors: ['在册批 bad：不是合法 JSON ⇒ 按无效处理（不给豁免）'] } }
    ).join('\n');
    expect(text).toContain('在册批 2 个');
    expect(text).toContain('先登记后写');
    expect(text).toContain('窗口外自动失效');
    expect(text).toContain('book-batch-a');
    expect(text).toContain('书批：甲');
    expect(text).toContain('（已过期 ⇒ 不给豁免）');
    expect(text).toContain('不是合法 JSON');
  });
});

describe('ⓓ 判别力证明：旧实现（不认登记表）vs 新实现（登记式归因）', () => {
  const oldImpl = (changes) => (changes.length ? 'leak' : 'ok');   // 还原旧行为（差异即红，不看登记表）
  const reg = (id, pid) => ({ id, pid, name: '书批：' + id,
    windowStartMs: T0 - 60000, windowEndMs: T1 + 60000, foreign: pid !== OUR, alive: true });

  it('在册他人那一笔：旧实现红（正是并行书批天天撞的那条假红 ✗）/ 新实现本次没验 ✓', () => {
    const changes = [{ rel: 'book-x/chapter.md', kind: 'changed', mtimeMs: MID }];
    const batches = [reg('book-batch-a', 777)];
    expect(oldImpl(changes)).toBe('leak');
    expect(guard.classifyRealWrites(changes, env({ registeredBatches: batches })).verdict).toBe('unverified');
  });

  it('**把登记表删掉 / 过期 ⇒ 同一夹具恢复判红**（豁免跟着证据走，不是永久的 ✓）', () => {
    const changes = [{ rel: 'book-x/chapter.md', kind: 'changed', mtimeMs: MID }];
    expect(guard.classifyRealWrites(changes, env({ registeredBatches: [] })).verdict).toBe('leak');
    const expired = [{ id: 'book-batch-a', pid: 777, name: '书批：甲',
      windowStartMs: T0 - 7200000, windowEndMs: T0 - 3600000, foreign: true, alive: false, expired: true }];
    expect(guard.classifyRealWrites(changes, env({ registeredBatches: expired })).verdict).toBe('leak');
  });

  it('陌生人那一笔：旧实现红 ✓ / **新实现也红** ✓（登记式没有变成"一律放过"）', () => {
    const changes = [{ rel: '_stranger-probe.json', kind: 'added', mtimeMs: MID }];
    expect(oldImpl(changes)).toBe('leak');
    expect(guard.classifyRealWrites(changes, env()).verdict).toBe('leak');
  });
});

describe('ⓓ 写者侧登记口（scripts/register-batch-writer.js 的纯函数面；main 只在 require.main 下跑）', () => {
  const cli = require('../scripts/register-batch-writer.js');

  it('buildRegistration：窗口 = now → now+minutes；名字必填（豁免要带原因）；minutes 夹到 [1, 上界]', () => {
    const r = cli.buildRegistration({ name: '书批：测试', minutes: 60, pid: 777, nowMs: MID, randHex: 'abcd' });
    expect(r.pid).toBe(777);
    expect(r.batchName).toBe('书批：测试');
    expect(r.windowStartMs).toBe(MID);
    expect(r.windowEndMs).toBe(MID + 60 * 60000);
    expect(r.batchId).toContain('p777');
    expect(r.batchId).toContain('abcd');            // 随机段进了 id ⇒ 并发唯一
    expect(() => cli.buildRegistration({ name: '  ', pid: 777 })).toThrow();
    const big = cli.buildRegistration({ name: 'x', minutes: 999999, pid: 777, nowMs: MID, randHex: 'ff' });
    expect(big.windowEndMs - big.windowStartMs).toBe(cli.MAX_MINUTES * 60000);   // 夹到上界 ⇒ 窗口有界
    expect(big.windowEndMs - big.windowStartMs).toBeLessThanOrEqual(guard.MAX_WINDOW_MS);
  });

  it('expiredIds：只挑"已过期超宽限 且 解析得动"的；活人登记 / 坏文件一律不动', () => {
    const live = { id: 'live', text: JSON.stringify({ windowEndMs: MID + 3600000 }) };
    const expired = { id: 'old', text: JSON.stringify({ windowEndMs: MID - 2 * 3600000 }) };
    const broken = { id: 'bad', text: '{oops' };
    expect(cli.expiredIds([live, expired, broken], MID + 3600000)).toEqual(['old']);
  });
});
describe('判别力证明：旧实现（一律判红）vs 新实现（三档）', () => {
  const oldImpl = (changes) => (changes.length ? 'leak' : 'ok');   // 还原旧行为（差异即红）

  const foreignCases = [
    [[{ rel: 'comnet/.ui-state.json', kind: 'changed', writerPid: 777, mtimeMs: MID, stampMs: MID }],
      env(), '别人开着的应用写自己的 .ui-state.json'],
    [[{ rel: 'comnet/comnet.json', kind: 'changed', mtimeMs: T0 - 3600000 }],
      env(), '保留时间戳搬进来的项目文件']
  ];
  for (const [changes, e, what] of foreignCases) {
    it('他人写入那一族（' + what + '）：旧实现红 ✗ / 新实现本次没验 ✓', () => {
      expect(oldImpl(changes), '旧实现在这一族上就该红（否则这组夹具判别不出东西）').toBe('leak');
      expect(guard.classifyRealWrites(changes, e).verdict).toBe('unverified');
    });
  }

  const ourCases = [
    [[{ rel: '_leak-inject-probe.json', kind: 'added', mtimeMs: MID }], env(), '本次注入写进来的探针文件'],
    [[{ rel: 'comnet/.ui-state.json', kind: 'changed', writerPid: OUR, mtimeMs: MID }], env(), '本进程写的 ui-state']
  ];
  for (const [changes, e, what] of ourCases) {
    it('本次自己写那一族（' + what + '）：旧实现红 ✓ / **新实现也红** ✓（没有一律放过）', () => {
      expect(oldImpl(changes)).toBe('leak');
      expect(guard.classifyRealWrites(changes, e).verdict).toBe('leak');
    });
  }
});

/* ============================================================
 * 「只报告」档：`.visits/`（访问日志）不再是"真实数据"（`r6` §2.5(a)）
 * ------------------------------------------------------------
 * 要治的损害（实测，不是推理）：裸 `mm-cli` 的**读**命令会追加 `.visits/<项目>.jsonl`
 * （`get` +81 B · `search` +91 B · `read` +178 B），它**既没有 `writerPid`、也不进 `.writers/` 登记**
 * ⇒ 四条"别人写的"正证据一条都不成立 ⇒ 落进 `else` 按本次算 ⇒ **G5 判红**。
 * **判红的理由是对的，错的是集合**（把日志追加与笔记数据改动放进同一个"真实数据"集合）。
 *
 * 三条判据（缺一条这一档就不算修好）：
 *   ① **真的改 `projects/<项目>/<项目>.json` ⇒ 仍然 `leak`** —— 不许被"放宽"洗掉；
 *   ② 只往 `.visits/` 追加 ⇒ **不再 `leak`**，但报文里**仍打印追加条数**（"只报告"不是"跳过"）；
 *   ③ `counts.ours` / `counts.foreign` 的口径**一个字节不动**（日志不进这两个计数）。
 * ============================================================ */
describe('「只报告」档：`.visits/` 访问日志（`r6` §2.5a）', () => {
  const LOG = '.visits/卖点讨论.jsonl';

  it('① 真的改 `projects/<项目>/<项目>.json` ⇒ **仍然 leak**（守卫没有被整体放宽）', () => {
    const r = guard.classifyRealWrites([
      { rel: '卖点讨论/卖点讨论.json', kind: 'changed', mtimeMs: MID },
      { rel: LOG, kind: 'changed', mtimeMs: MID }
    ], env());
    expect(r.verdict).toBe('leak');
    expect(r.counts.ours).toBe(1);                    // 笔记数据那一处照旧算"本次"
    expect(r.items.filter((i) => i.verdict === 'leak').map((i) => i.rel)).toEqual(['卖点讨论/卖点讨论.json']);
    // 日志那一处**不许**被算成"本次证据"，但也不许消失（它确实变了）
    expect(r.items.filter((i) => i.verdict === 'log').map((i) => i.rel)).toEqual([LOG]);
    expect(r.reason).toContain('`.visits/` 访问日志追加');
  });

  it('② 只往 `.visits/` 追加一行 ⇒ **不再 leak**，但报文**仍打印追加条数**', () => {
    const r = guard.classifyRealWrites([{ rel: LOG, kind: 'changed', mtimeMs: MID }], env());
    expect(r.verdict).not.toBe('leak');
    expect(r.verdict).toBe('logs');
    expect(r.counts.logs).toBe(1);
    expect(r.counts.changed).toBe(1);                 // 变化本身仍然被数出来（"只报告"≠"没发生"）
    const text = guard.summaryLines(r).join('\n');
    expect(text).toContain('`.visits/` 访问日志有追加');
    expect(text).toContain('只报告（`.visits/`）1');   // 条数进汇总行
    expect(text).toContain('访问日志追加 —— **只报告**');
    expect(text).toContain('确实变了、也确实逐条打出来了');
    expect(text).toContain('不动');
    // 反例：这条读数不许被读成"没验"
    expect(text).not.toContain('本次没验');
  });

  it('②′ `.visits/` 的**惰性创建**（新增一个空日志文件）同样只报告', () => {
    const r = guard.classifyRealWrites([{ rel: '.visits/comnet.jsonl', kind: 'added', mtimeMs: MID }], env());
    expect(r.verdict).toBe('logs');
    expect(r.counts.added).toBe(1);
  });

  it('③ `counts.ours` / `counts.foreign` 口径不动：日志既不算本次也不算他人', () => {
    const only = guard.classifyRealWrites([{ rel: LOG, kind: 'changed', mtimeMs: MID }], env());
    expect(only.counts.ours).toBe(0);
    expect(only.counts.foreign).toBe(0);
    expect(only.counts.logs).toBe(1);
    // 他人写入那一处照旧进 foreign；日志仍然只报告
    const mixed = guard.classifyRealWrites([
      { rel: 'comnet/comnet.json', kind: 'changed', mtimeMs: T0 - 3600000 },
      { rel: LOG, kind: 'changed', mtimeMs: MID }
    ], env());
    expect(mixed.verdict).toBe('unverified');
    expect(mixed.counts.foreign).toBe(1);
    expect(mixed.counts.ours).toBe(0);
    expect(mixed.counts.logs).toBe(1);
    expect(mixed.reason).toContain('只报告');
  });

  it('路径判据只认同名的 `.visits` 那一段（`.visitsx/` / 项目内同名目录都不算日志）', () => {
    expect(guard.isReportOnlyLog('.visits/a.jsonl')).toBe(true);
    expect(guard.isReportOnlyLog('.visits/sub/a.jsonl')).toBe(true);
    expect(guard.isReportOnlyLog('.visitsx/a.jsonl')).toBe(false);
    expect(guard.isReportOnlyLog('comnet/.visits/a.jsonl')).toBe(false);
    expect(guard.isReportOnlyLog('comnet/comnet.json')).toBe(false);
    // 项目里真的有个叫 .visits 的目录 ⇒ 它是**项目数据**，不许被放过
    const r = guard.classifyRealWrites([{ rel: 'comnet/.visits/a.jsonl', kind: 'changed', mtimeMs: MID }], env());
    expect(r.verdict).toBe('leak');
  });

  it('判别力：旧实现（差异即红）在同一夹具上**必红** —— 这条降档确实改变了读数', () => {
    const oldImpl = (changes) => (changes.length ? 'leak' : 'ok');
    const changes = [{ rel: LOG, kind: 'changed', mtimeMs: MID }];
    expect(oldImpl(changes), '旧实现就该红（否则这组夹具判别不出东西）').toBe('leak');
    expect(guard.classifyRealWrites(changes, env()).verdict).toBe('logs');
    // 但"真改数据"这一族在新实现下**仍然红** ✓
    expect(guard.classifyRealWrites([{ rel: '卖点讨论/卖点讨论.json', kind: 'changed', mtimeMs: MID }],
      env()).verdict).toBe('leak');
  });

  it('真值采不到时，日志这一档也救不了 ⇒ 仍然 error（不许用"只报告"绕开 error）', () => {
    const r = guard.classifyRealWrites([{ rel: LOG, kind: 'changed', mtimeMs: MID }],
      env({ probeError: 'readdir 失败' }));
    expect(r.verdict).toBe('error');
  });
});
