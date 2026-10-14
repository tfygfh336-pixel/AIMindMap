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
 * 判别力证明（**这是本批真正改掉的行为**）：把**旧实现**放回同一组夹具上。
 * 旧实现 = "真实侧有差异 ⇒ 一律判红"（不看写入者 pid、不看时间戳、不问环境）。
 * 判据：它在"他人写入"那两族夹具上**必红**（这就是现场读到的那条假红的形状），
 * 而新实现在同一组夹具上给出 `unverified`（不判红、也不当通过）✓；
 * 同时新实现在"本次自己写"那组夹具上**仍然判红** ⇒ 降档没有变成"一律放过" ✗。
 * ========================================================================== */
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
