/* ============================================================
 * tests/move-index-bounds.test.js — `move --index` 的**上界**契约（2026-10-14 修复）
 * 运行：npx vitest run tests/move-index-bounds.test.js
 * ------------------------------------------------------------
 * ## 守的缺陷（**真缺陷**，不是假设）
 * `src/tree-utils.js` 的 `moveNode` 对越界 index **静默 clamp 到末尾**：
 *     const idx = (… && index <= parent.children.length) ? index : parent.children.length;
 * 而 `move` 原先只校验"非负整数"、**没有上界** ⇒ `move x y --index 999` 打印「已移动」、**退出码 0**，
 * 实际插到了**末尾**。调用方（脚本 / AI）以为插到了第 999 位。
 * MCP 的 `move_node` 把 `index` **直接透传**成 `--index`（`scripts/mcp-server.js`）⇒ AI 侧同样会踩。
 *
 * ## 为什么上界不是"目标父当前的子节点数"（**差一陷阱**，本文件第 ③ 条专治它）
 * `moveNode` 的顺序是 **先 removeNode、再 splice(k,0,node)** ⇒ 判定与插入都发生在"已摘掉该节点"的树上：
 *     L' = 目标父**在移除该节点之后**的子节点数 = 当前子数 − （该节点本来就是它的孩子 ? 1 : 0）
 *     合法范围 = 0 … L'
 * ⇒ **同父内重排**时 L' 比"当前子数"**小 1**。按"当前子数"算 ⇒ 会把"拖到最后一个位置"判成越界（假红 ✗）。
 *
 * ## 为什么在**临时沙箱**里跑（`AI_MINDMAP_PROJECTS_DIR`）
 * 与 `tests/idem.test.js` 同一套路：不碰真实 `projects/**`，也不与并行跑门禁的其它流互踩；
 * 且"盘上逐字节不变"这条强判据在临时目录里才成立（别处可能有人写）。
 * ⚠️ 顺序不能换：`cli/core.js` 在**模块加载时**读该环境变量 ⇒ 必须先设它、再**动态** require CLI。
 *
 * ## 判据与"能红"（每条都对着一个判据；注入证明见交付说明）
 *   ① 跨父越界 ⇒ 非 0 + 报合法范围 + **盘上逐字节不变**；
 *   ② 正向对照 ⇒ 同一个节点、两个合法值落点**不同**（证明读数有分辨力，不是恒真）；
 *   ③ 同父重排越界（差一陷阱）⇒ 非 0；
 *   ④ 边界：L' 成功 / L'+1 失败；不带 `--index` 的默认档照旧（末尾追加）；
 *   ⑤ 事务路 `apply` 的 move op：越界 ⇒ **整份未执行** + 盘上逐字节不变；
 *   ⑥ `--dry-run` 的**能力边界**：它会**报**这一条（✗ 行里带合法范围），但退出码仍按既有契约是 0
 *      —— 这条把边界**钉住**，同时说明"预览看得出、批量未执行"。
 * ============================================================ */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** 沙箱项目名（全文件只在它上面写；afterAll 整目录清掉） */
const P = 'move-idx-probe';
/** 目标父（跨父移动用） */
const DST = 'ix-dst';

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-moveidx-'));
const OPS_DIR = path.join(SANDBOX, 'ops');
fs.mkdirSync(OPS_DIR, { recursive: true });

let invokeSync = null;

const projFile = () => path.join(SANDBOX, P, P + '.json');
/** **逐字节**判据用（Buffer，不是字符串） */
const readBytes = () => fs.readFileSync(projFile());
const readJson = () => JSON.parse(fs.readFileSync(projFile(), 'utf8').replace(/^\uFEFF/, ''));

/** 跑一条命令（进程内同步） */
function cli(args) {
  const r = invokeSync(args);
  return { code: r.code, out: r.stdout + r.stderr };
}

function findNode(id) {
  const d = readJson();
  return (function walk(n) {
    if (!n) return null;
    if (n.id === id) return n;
    for (const c of (n.children || [])) { const r = walk(c); if (r) return r; }
    return null;
  })(d.data);
}

/** 某个父节点的直接子 id 序列（读盘真值，不走 CLI 的包装视图） */
function kids(pid) {
  const p = findNode(pid);
  return p ? (p.children || []).map((c) => c.id) : null;
}

function opsFile(name, content) {
  const p = path.join(OPS_DIR, name);
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  return p;
}

beforeAll(async () => {
  process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;      // ⚠️ 必须在 require CLI 之前
  const main = await import('../cli/main.js');
  invokeSync = main.invokeSync;
  expect(invokeSync).toBeTypeOf('function');
  expect(cli(['init', P, '--title', 'move --index 上界探针']).code).toBe(0);
  // root 的孩子：ix-a / ix-b / ix-c / ix-dst（顺序即 index 语义的基准）
  ['ix-a', 'ix-b', 'ix-c', DST].forEach((id) => {
    expect(cli(['add', P, 'root', '--topic', id, '--id', id]).code).toBe(0);
  });
  // DST 的孩子：ix-d1 / ix-d2
  ['ix-d1', 'ix-d2'].forEach((id) => {
    expect(cli(['add', P, DST, '--topic', id, '--id', id]).code).toBe(0);
  });
  expect(kids('root')).toEqual(['ix-a', 'ix-b', 'ix-c', DST]);
  expect(kids(DST)).toEqual(['ix-d1', 'ix-d2']);
});

afterAll(() => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* 沙箱清理失败不影响判定 */ }
});

describe('move --index 的上界（越界必须响亮拒绝，不许静默落到末尾）', () => {
  it('① 跨父越界 --index 999 ⇒ 非 0 + 报出合法范围 + **盘上逐字节不变**', () => {
    const before = readBytes();
    const r = cli(['move', P, 'ix-a', DST, '--index', '999']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('--index 越界');
    // 报出**合法范围**（光"失败"不够：接手者要照着改）
    expect(r.out).toContain('合法范围 0–2');
    expect(r.out).toContain('未写盘');
    expect(Buffer.compare(before, readBytes())).toBe(0);        // 逐字节
    expect(kids(DST)).toEqual(['ix-d1', 'ix-d2']);              // 结构也没动
  });

  it('② 正向对照：同一节点两个**合法**值 ⇒ 都成功且**落点不同**（判据有分辨力）', () => {
    const r0 = cli(['move', P, 'ix-a', DST, '--index', '0']);
    expect(r0.code).toBe(0);
    expect(kids(DST)).toEqual(['ix-a', 'ix-d1', 'ix-d2']);      // 落在第 0 位

    const r2 = cli(['move', P, 'ix-a', DST, '--index', '2']);   // L' = 2（跨父：目标父当前 2 个子）
    expect(r2.code).toBe(0);
    expect(kids(DST)).toEqual(['ix-d1', 'ix-d2', 'ix-a']);      // 落在第 2 位
  });

  it('③ 同父重排的**差一陷阱**：--index 3 越界（L\' = 当前子数 3 − 1 = 2）', () => {
    // 此时 DST 的孩子是 [ix-d1, ix-d2, ix-a]（3 个）⇒ 合法范围 0–2，不是 0–3
    expect(kids(DST)).toEqual(['ix-d1', 'ix-d2', 'ix-a']);
    const before = readBytes();
    const r = cli(['move', P, 'ix-a', DST, '--index', '3']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('合法范围 0–2');                    // 若按"当前子数 3"算 ⇒ 这里会放过 ⇒ 假绿
    expect(Buffer.compare(before, readBytes())).toBe(0);
  });

  it('④ 边界与默认档：L\' 成功 · 不带 --index 仍照旧追加到末尾', () => {
    // 同父重排到 L' = 2 ⇒ 成功
    const r = cli(['move', P, 'ix-d1', DST, '--index', '2']);
    expect(r.code).toBe(0);
    expect(kids(DST)).toEqual(['ix-d2', 'ix-a', 'ix-d1']);

    // 默认档（不给 --index）= 追加到末尾：语义与修复前**一字不变**
    const beforeRoot = kids('root');
    const rd = cli(['move', P, 'ix-b', 'root']);
    expect(rd.code).toBe(0);
    expect(kids('root')).toEqual(beforeRoot.filter((x) => x !== 'ix-b').concat(['ix-b']));
  });

  it('⑤ 事务路 apply 的 move op：越界 ⇒ **整份未执行** + 盘上逐字节不变', () => {
    const before = readBytes();
    const f = opsFile('bad-index.json', { version: 1, ops: [{ op: 'move', id: 'ix-d2', parent: 'root', index: 999 }] });
    const r = cli(['apply', P, '--ops-file', f]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('--index 越界');
    expect(Buffer.compare(before, readBytes())).toBe(0);

    // 正向对照：同一份形状、index 合法 ⇒ 通过（证明拒绝的是**越界**而不是这条 op 本身）
    const okFile = opsFile('good-index.json', { version: 1, ops: [{ op: 'move', id: 'ix-d2', parent: 'root', index: 0 }] });
    const rOk = cli(['apply', P, '--ops-file', okFile]);
    expect(rOk.code).toBe(0);
    expect(kids('root')[0]).toBe('ix-d2');
  });

  it('⑥ --dry-run 的能力边界：**报得出**这一条（✗ 行带合法范围），退出码仍按既有契约是 0', () => {
    const before = readBytes();
    const f = opsFile('dry-index.json', { version: 1, ops: [{ op: 'move', id: 'ix-c', parent: DST, index: 99 }] });
    const r = cli(['apply', P, '--ops-file', f, '--dry-run']);
    expect(r.out).toContain('会失败');                          // 预览里看得见
    expect(r.out).toContain('--index 越界');
    expect(r.out).toContain('合法范围');
    expect(Buffer.compare(before, readBytes())).toBe(0);        // 预览不写盘
  });

  it('⑦ 回归：**非整数**那一支没被本批改坏（原有的"必须是非负整数"报文照旧）', () => {
    // 本批只**新增**上界，不动既有的非负/整数校验 —— 这条钉住"没顺手改坏旧的"
    const before = readBytes();
    const r = cli(['move', P, 'ix-c', DST, '--index', 'abc']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('--index 必须是非负整数');
    expect(Buffer.compare(before, readBytes())).toBe(0);
    const rNeg = cli(['move', P, 'ix-c', DST, '--index', '-1']);
    expect(rNeg.code).not.toBe(0);
    expect(rNeg.out).toContain('--index 必须是非负整数');
  });
});
