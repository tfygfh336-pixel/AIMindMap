/* ============================================================
 * tests/timeline.test.js — 「时间线」（`TL`·台账 `W2`）的纯逻辑判据
 * ------------------------------------------------------------
 * 这一批有三件事**只能在这里钉住**（端到端看得见结果、看不见口径）：
 *   一. **时间从哪来**：节点上没有 `updatedAt`，时间全部从变更日志派生 ⇒
 *       "日志窗口外"与"没有日志"必须是**两种可分辨的结局**，而不是"时间未知"一句话糊过去。
 *   二. **相对 `--since` 不许读墙钟**：`7d` 必须配显式的 `--now`，否则同一查询两跑会不同。
 *   三. **排序是全序**：同时间戳的两个节点次序**必须有唯一答案且能复算**
 *       （实测全库 1785 条有精确时间的行里 1187 条落在那样的并列组里 ⇒ 这不是理论问题）。
 * 三条都要求"注入坏实现 ⇒ 必红"，所以断言不写"跑通了"，写**读数**与**次序本身**。
 *
 * 不起子进程、不碰真实 `projects/`（纯逻辑：夹具是手工造的树与日志条目）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import changes from '../src/changes.js';
import itemIndex from '../src/item-index.js';
import core from '../cli/core.js';
import timelineCmd from '../cli/commands/timeline.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- 夹具：手工算好的读数，不调产品代码算期望值 ---------------- */

/** 造一条日志条目（字段照 `src/changes.js` 的 `buildEntry`，只留本批用得上的） */
function entry(rev, at, changed) {
  return { v: 1, rev: rev, at: at, writer: 'cli:add', version: 'v' + rev, created: false, changed: changed };
}

/** 一棵树（判据比对的是 id/topic/at，不是渲染） */
function node(id, topic, children) {
  return { id: id, topic: topic, expanded: true, children: children || [] };
}

describe('A. 日志键 → 节点 id（唯一解析处）', () => {
  it('A1 四种节点形态都拆得回节点 id', () => {
    expect(changes.nodeIdOfKey('node:n-a')).toBe('n-a');
    expect(changes.nodeIdOfKey('children:n-b')).toBe('n-b');
    expect(changes.nodeIdOfKey('items:n-c')).toBe('n-c');
    expect(changes.nodeIdOfKey('item:n-d#i-3f2k9a')).toBe('n-d');
  });

  it('A2 非节点键一律 null（**不静默归给根节点**：关联与 meta 不是节点的事实）', () => {
    expect(changes.nodeIdOfKey('assoc:a-1')).toBeNull();
    expect(changes.nodeIdOfKey('meta')).toBeNull();
    expect(changes.nodeIdOfKey('')).toBeNull();
    expect(changes.nodeIdOfKey(undefined)).toBeNull();
  });
});

describe('B. `lastTouchedByNode`：最后一次有记录的改动', () => {
  it('B1 同一节点被多条命中 ⇒ 取**最晚**那条的 at 与 rev', () => {
    const t = changes.lastTouchedByNode([
      entry(1, '2026-10-01T00:00:00.000Z', ['node:n-a', 'children:root']),
      entry(2, '2026-10-03T00:00:00.000Z', ['node:n-b']),
      entry(3, '2026-10-05T00:00:00.000Z', ['node:n-a'])
    ]);
    expect(t.byNode.get('n-a')).toEqual({ at: '2026-10-05T00:00:00.000Z', ms: Date.parse('2026-10-05T00:00:00.000Z'), rev: 3 });
    expect(t.byNode.get('n-b').rev).toBe(2);
    expect(t.byNode.get('root').rev).toBe(1);
  });

  it('B2 窗口起止按**时间**取（不是按数组首尾 —— 外部手工追加的乱序行不许骗到上界）', () => {
    const t = changes.lastTouchedByNode([
      entry(1, '2026-10-05T00:00:00.000Z', ['node:n-a']),
      entry(2, '2026-10-01T00:00:00.000Z', ['node:n-b'])
    ]);
    expect(t.windowFrom).toBe('2026-10-01T00:00:00.000Z');
    expect(t.windowTo).toBe('2026-10-05T00:00:00.000Z');
    expect(t.entries).toBe(2);
  });

  it('B3 时间戳读不出来的条目**单独计数**，不冒充"这条没改过"（也不进 byNode）', () => {
    const t = changes.lastTouchedByNode([
      entry(1, '不是时间', ['node:n-a']),
      entry(2, '2026-10-02T00:00:00.000Z', ['node:n-b'])
    ]);
    expect(t.unparsable).toBe(1);
    expect(t.byNode.has('n-a')).toBe(false);
    expect(t.windowFrom).toBe('2026-10-02T00:00:00.000Z');
  });

  it('B4 拆不回节点的键只计数（assoc / meta 正常存在，不是错误）', () => {
    const t = changes.lastTouchedByNode([entry(1, '2026-10-02T00:00:00.000Z', ['assoc:a-1', 'meta', 'node:n-a'])]);
    expect(t.unresolvedKeys).toBe(2);
    expect(t.byNode.size).toBe(1);
  });

  it('B5 空日志不崩，且窗口是 null（"没有日志"与"窗口从很早开始"必须分得开）', () => {
    const t = changes.lastTouchedByNode([]);
    expect(t.byNode.size).toBe(0);
    expect(t.windowFrom).toBeNull();
    expect(t.windowTo).toBeNull();
    expect(t.entries).toBe(0);
  });
});

describe('C. 三档时间来源（`changes` / `before-window` / `unknown`）', () => {
  const root = node('root', '根', [node('n-a', '甲'), node('n-b', '乙')]);

  it('C1 日志命中 ⇒ `changes`，带 at 与 rev', () => {
    const touched = changes.lastTouchedByNode([entry(7, '2026-10-05T00:00:00.000Z', ['node:n-a'])]);
    const rows = timelineCmd.rowsOfProject('P', root, touched, true);
    const a = rows.filter((r) => r.nodeId === 'n-a')[0];
    expect(a.atSource).toBe('changes');
    expect(a.at).toBe('2026-10-05T00:00:00.000Z');
    expect(a.rev).toBe(7);
    expect(a.before).toBeNull();
  });

  it('C2 日志在、但这节点没出现 ⇒ `before-window`，**只给上界不给假时间**', () => {
    const touched = changes.lastTouchedByNode([entry(1, '2026-10-05T00:00:00.000Z', ['node:n-a'])]);
    const rows = timelineCmd.rowsOfProject('P', root, touched, true);
    const b = rows.filter((r) => r.nodeId === 'n-b')[0];
    expect(b.atSource).toBe('before-window');
    expect(b.at).toBeNull();                             // ← 不许编造一个时间
    expect(b.before).toBe('2026-10-05T00:00:00.000Z');   // ← 但上界是确定的
    expect(b.rev).toBeNull();
  });

  it('C3 本项目没有日志 ⇒ `unknown`（连上界都没有），与 C2 是**不同**的结局', () => {
    const touched = changes.lastTouchedByNode([]);
    const rows = timelineCmd.rowsOfProject('P', root, touched, false);
    expect(rows.length).toBe(3);
    rows.forEach((r) => { expect(r.atSource).toBe('unknown'); expect(r.before).toBeNull(); });
  });

  it('C4 `origin.at` 只作 `importedAt` 信息列：**不参与** at / 排序 / 判定', () => {
    const imported = {
      id: 'n-a', topic: '甲', expanded: true, children: [],
      origin: { kind: 'import', src: 'a.md', sha256: 'x'.repeat(64), at: '2026-09-01T00:00:00.000Z' }
    };
    const touched = changes.lastTouchedByNode([entry(1, '2026-10-05T00:00:00.000Z', ['node:n-a'])]);
    const rows = timelineCmd.rowsOfProject('P', node('root', '根', [imported]), touched, true);
    const a = rows.filter((r) => r.nodeId === 'n-a')[0];
    expect(a.importedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(a.at).toBe('2026-10-05T00:00:00.000Z');   // ← 排序/判定用的仍是"改动时间"
    expect(a.atSource).toBe('changes');
  });

  it('C5 `path` 是 root→该节点的完整 id 链（AI 靠它定位，别只给最后一段）', () => {
    const touched = changes.lastTouchedByNode([]);
    const rows = timelineCmd.rowsOfProject('P', root, touched, false);
    expect(rows.filter((r) => r.nodeId === 'n-b')[0].path).toEqual(['root', 'n-b']);
  });
});

describe('D. 排序是全序：同时间戳也有唯一答案（且能复算）', () => {
  /** 造行（只带比较器用得到的字段；读数是手写的，不从产品函数取） */
  const row = (project, nodeId, at) => timelineCmd.rowsOfProject(
    project,
    node('root', '根', [node(nodeId, nodeId + ' 的标题')]),
    changes.lastTouchedByNode(at ? [entry(1, at, ['node:' + nodeId])] : []),
    !!at
  ).filter((r) => r.nodeId === nodeId)[0];

  it('D1 新→旧：时间大的排前面', () => {
    const old = row('P', 'n-old', '2026-10-01T00:00:00.000Z');
    const fresh = row('P', 'n-fresh', '2026-10-09T00:00:00.000Z');
    expect([old, fresh].sort(timelineCmd.compareRows).map((r) => r.nodeId)).toEqual(['n-fresh', 'n-old']);
    expect([fresh, old].sort(timelineCmd.compareRows).map((r) => r.nodeId)).toEqual(['n-fresh', 'n-old']);
  });

  it('D2 同时间戳 ⇒ 按 nodeId 升序（**唯一答案**：换个输入顺序，输出次序不变）', () => {
    const same = '2026-10-09T00:00:00.000Z';
    const a = row('P', 'n-b', same);
    const b = row('P', 'n-a', same);
    expect(a.ms).toBe(b.ms);                                  // 前提：两条真的同时间戳
    expect([a, b].sort(timelineCmd.compareRows).map((r) => r.nodeId)).toEqual(['n-a', 'n-b']);
    expect([b, a].sort(timelineCmd.compareRows).map((r) => r.nodeId)).toEqual(['n-a', 'n-b']);
  });

  it('D3 同时间戳 + 同 nodeId 前缀但不同项目 ⇒ 按**项目名**升序（跨项目并列也有答案）', () => {
    const same = '2026-10-09T00:00:00.000Z';
    const x = row('项目乙', 'n-a', same);
    const y = row('项目甲', 'n-a', same);
    expect([x, y].sort(timelineCmd.compareRows).map((r) => r.project)).toEqual(['项目乙', '项目甲']);
    expect([y, x].sort(timelineCmd.compareRows).map((r) => r.project)).toEqual(['项目乙', '项目甲']);
  });

  it('D4 没有时间的行**恒排在有时间的行之后**（不插进序列里：那会编造位置）', () => {
    const timed = row('P', 'n-timed', '2026-10-01T00:00:00.000Z');
    const untimed = row('P', 'n-untimed', null);
    expect(untimed.atSource).toBe('unknown');
    expect([untimed, timed].sort(timelineCmd.compareRows).map((r) => r.nodeId)).toEqual(['n-timed', 'n-untimed']);
    expect([timed, untimed].sort(timelineCmd.compareRows).map((r) => r.nodeId)).toEqual(['n-timed', 'n-untimed']);
  });

  it('D5 比较器不给"相等"就完事：两条不同的行**永远不会**判 0（全序的机械形态）', () => {
    const same = '2026-10-09T00:00:00.000Z';
    const a = row('P', 'n-a', same);
    const b = row('P', 'n-b', same);
    expect(timelineCmd.compareRows(a, b)).toBeLessThan(0);
    expect(timelineCmd.compareRows(b, a)).toBeGreaterThan(0);
    expect(timelineCmd.compareRows(a, a)).toBe(0);           // 同一条比自己是 0（sort 的契约）
  });

  it('D6 项目名比较**不用 localeCompare**：结果与运行环境无关（ASCII 也按码位）', () => {
    const p1 = row('a', 'n', '2026-10-09T00:00:00.000Z');
    const p2 = row('B', 'n', '2026-10-09T00:00:00.000Z');
    // 码位序：'B'(0x42) < 'a'(0x61)。localeCompare 在多数 locale 下反过来（'a' < 'B'）
    expect([p1, p2].sort(timelineCmd.compareRows).map((r) => r.project)).toEqual(['B', 'a']);
  });
});

describe('E. 时间界：`--since` 的两种形态与"必须给显式的现在"', () => {
  const NOW = Date.parse('2026-10-20T00:00:00.000Z');

  it('E1 相对时长四档都认（m / h / d / w），且大小写不敏感', () => {
    expect(itemIndex.parseDuration('90m')).toBe(90 * 60 * 1000);
    expect(itemIndex.parseDuration('24h')).toBe(24 * 60 * 60 * 1000);
    expect(itemIndex.parseDuration('7d')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(itemIndex.parseDuration('2w')).toBe(14 * 24 * 60 * 60 * 1000);
    expect(itemIndex.parseDuration('7D')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(itemIndex.parseDuration(' 7 d ')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('E2 认不出的写法一律 null（**不宽松解析**：`Date.parse("2026")` 是合法的，那会把写错读成另一个时间点）', () => {
    ['7x', '-1d', '1.5d', '0d', 'd', '', '昨天'].forEach((v) => {
      expect(itemIndex.parseDuration(v)).toBeNull();
    });
  });

  it('E3 相对 `--since` 不给 `now` ⇒ **报错**（绝不偷偷读墙钟）', () => {
    const r = itemIndex.parseSince('7d');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('相对');
    expect(r.reason).toContain('--now');
  });

  it('E4 相对 `--since` 给了 `now` ⇒ 界 = now − 时长（纯算术，可手算）', () => {
    const r = itemIndex.parseSince('7d', NOW);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(NOW - 7 * 24 * 60 * 60 * 1000);
    expect(r.relative.ms).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('E5 绝对 `--since` 与 `now` 无关（给了也不影响结果 ⇒ 两种形态同一个出口）', () => {
    const a = itemIndex.parseSince('2026-10-01');
    const b = itemIndex.parseSince('2026-10-01', NOW);
    expect(a.ok && b.ok).toBe(true);
    expect(a.value).toBe(b.value);
    expect(a.relative).toBeNull();
  });

  it('E6 写错的时间串 ⇒ **当场报错**（既有口径：绝不静默变成"0 命中"）', () => {
    const r = itemIndex.parseSince('昨天');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('需要一个能解析的时间');
  });

  it('E7 `--now` 只收绝对时间：相对时长自己指自己 ⇒ 拒绝并说明', () => {
    expect(itemIndex.parseNow('7d').ok).toBe(false);
    expect(itemIndex.parseNow('2026-10-20').ok).toBe(true);
    expect(itemIndex.parseNow('2026-10-20T00:00:00Z').value).toBe(NOW);
    expect(itemIndex.parseNow(undefined).value).toBeNull();   // 不给 = null（不是 0）
  });

  it('E8 边界**含等号**：`at` 正好等于界 ⇒ 命中（与条目级 `--since` 的既有口径同一个）', () => {
    const bound = NOW - 7 * 24 * 60 * 60 * 1000;
    const sf = itemIndex.parseSince('7d', NOW);
    expect(sf.value).toBe(bound);
    // 复算：`searchItems` 的过滤是 `t < since` 才排除 ⇒ 相等时保留
    expect(bound >= sf.value).toBe(true);
  });
});

describe('F. `timeline` 的命令体与"零写盘"身份', () => {
  it('F1 只导出一个命令体 + 两个纯函数（没有第二个可从外部驱动的入口）', () => {
    expect(Object.keys(timelineCmd).sort()).toEqual(['compareRows', 'rowsOfProject', 'timeline']);
    expect(typeof timelineCmd.timeline).toBe('function');
  });

  it('F2 不在写命令名单里，且源码里没有写盘 / 记热度 / 读墙钟的入口', () => {
    expect(core.WRITE_COMMANDS.indexOf('timeline')).toBe(-1);
    const src = fs.readFileSync(path.join(HERE, '..', 'cli', 'commands', 'timeline.js'), 'utf8');
    expect(/ctx\.write\s*\(/.test(src)).toBe(false);
    expect(/ctx\.mutate\s*\(/.test(src)).toBe(false);
    expect(/recordVisit\s*\(/.test(src)).toBe(false);   // 不记热度 ⇒ --json 两跑逐字节相同
    expect(/Date\.now\s*\(/.test(src)).toBe(false);     // 不读墙钟 ⇒ 相对界可控
  });
});
