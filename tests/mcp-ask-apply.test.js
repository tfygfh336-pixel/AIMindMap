/* ============================================================
 * tests/mcp-ask-apply.test.js —— MCP 工具 `ask_apply`（CLI `ask-apply` 的透传）· 台账 `W21`
 * 运行：node node_modules/vitest/vitest.mjs run --pool=threads tests/mcp-ask-apply.test.js
 * ------------------------------------------------------------
 * 本文件钉的是"**工具面补齐**"这一半（定题 `00-定题.md` §1/§2）：
 *
 *   ① **它存在、且形状对**：`TOOLS` 里有 `ask_apply`、必填只有 `project`/`id`（**不写 answer** ——
 *      空答案由 CLI 判成业务失败，不当成"参数缺了"那种协议错误；`answer_file` 那条路也不会被挡），
 *      名字唯一，工具数 = 53（写死值是**故意**的：它是交付里"N→M"的判据，与 `docs/VERIFY.md` 同源；
 *      `I-1` 之后 53 —— 新增的那条是只读的 `features`）。
 *
 *   ② **它真的是写类**：`ask-apply` 在 `cli/core.js` 的 `WRITE_COMMANDS` 与 `DRY_RUN_COMMANDS` 里，
 *      而本工具挂在 `DRY_RUN_TOOL_CMD` 上、schema 里也挂了 `dry_run` —— 三处同源（映射不许漂移）。
 *
 *   ③ **真调用落盘**（子进程转发同一个 CLI，不是复制逻辑）：`qa` 记录 + `detail` 末尾都到位，
 *      变更日志的 `by` 是 **`mcp:ask-apply`**（证明这一笔经的是 MCP 这条路，不是直连 CLI）。
 *
 *   ④ **预览与失败都不写盘**：`dry_run:true` ⇒ 项目文件逐字节不变；空答案 / 节点不存在 ⇒
 *      `ok:false` 且盘上零改动（**空记录比报错危险得多** —— 那条纪律由 CLI 守着，本文件只验结果）。
 *
 * ## 环境要点（与 tests/w8-dry-run.test.js 同口径）
 *   `AI_MINDMAP_PROJECTS_DIR` 必须在 require `cli/main.js` / `scripts/mcp-server.js` **之前**设好
 *   （`cli/core.js` 在模块加载时读它），并当场自证重定向生效；`projects/` 真实目录**只读**，
 *   夹具与清理全在临时沙箱（`tests/_tmp-cleanup.js` 统一收尾）。
 * ## 为什么用 `mcp.callTool` 而不是 `invokeSync`
 *   本文件要验的正是**MCP 这一层**：工具名 → argv 的映射、`dry_run` 注入、`isError` 分流。
 *   `callTool` 内部 `spawnSync` 起的是**同一个** `cli/mm-cli.js` ⇒ 与真客户端走同一条路。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);

/** 沙箱：必须在 require 两个入口之前设好（`cli/core.js` 加载时读这个环境变量） */
const SANDBOX = makeTmp('mm-w21-askapply-');
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const mcp = require('../scripts/mcp-server.js');
const core = require('../cli/core.js');
const { invokeSync } = require('../cli/main.js');

afterAll(cleanupAll);

const PROJ = 'w21ask';
const projDir = () => path.join(SANDBOX, PROJ);
const projFile = () => path.join(projDir(), PROJ + '.json');
const changesFile = () => path.join(projDir(), '.changes.jsonl');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** 建一个项目：root 下挂一个节点 `n-a`（`ask-apply` 就落在这个节点上） */
function seed() {
  fs.rmSync(projDir(), { recursive: true, force: true });
  fs.mkdirSync(projDir(), { recursive: true });
  fs.writeFileSync(projFile(), JSON.stringify({
    meta: { name: PROJ, author: '', version: '0.19.0', formatVersion: 2 },
    format: 'node_tree',
    data: {
      id: 'root', topic: 'root', expanded: true,
      children: [{ id: 'n-a', topic: '节点甲', detail: '<p>原有内容</p>', children: [] }]
    }
  }, null, 2), 'utf8');
}
const readNode = (id) => {
  const j = JSON.parse(fs.readFileSync(projFile(), 'utf8'));
  const walk = (n) => {
    if (n.id === id) return n;
    for (const c of n.children || []) { const r = walk(c); if (r) return r; }
    return null;
  };
  return walk(j.data);
};
const tool = (name) => mcp.TOOLS.filter((t) => t.name === name)[0];

/* ============================================================================
 * 一、工具面：存在 / 形状 / 三处同源
 * ========================================================================== */
describe('W21-M1 工具存在且形状对（必填只有 project/id：答案是否为空由 CLI 判）', () => {
  it('M1.1 工具数 53、名字唯一、`ask_apply` 在里面（写死值是交付判据，见文件头）', () => {
    // 2026-10-20（`I-1`）：52 → 53 —— 新增 `features`（`features` 的只读 MCP 透传）。
    expect(mcp.TOOLS.length).toBe(53);
    expect(new Set(mcp.TOOLS.map((t) => t.name)).size).toBe(53);
    expect(tool('ask_apply')).toBeTruthy();
  });

  it('M1.2 必填只有 project / id；answer 与 answer_file 都不是必填（空答案留给 CLI 响亮拒绝）', () => {
    expect(tool('ask_apply').inputSchema.required).toEqual(['project', 'id']);
    const props = tool('ask_apply').inputSchema.properties;
    ['answer', 'answer_file', 'question', 'model', 'at', 'as_child', 'child_id'].forEach((k) => {
      expect(props[k], '缺参数 ' + k).toBeTruthy();
      // 每个参数的说明都要写明"对应 CLI 的哪个开关"（一层透传的可读性契约）
      expect(String(props[k].description)).toMatch(/--[a-z-]+/);
    });
  });

  it('M1.3 描述里说清了三件事：写类 + 一次原子写做三件 + 空回答被拒（模型看得懂才不会误用）', () => {
    const d = String(tool('ask_apply').description);
    expect(d).toContain('写类');
    expect(d).toContain('qa');
    expect(d).toContain('detail');
    expect(d).toContain('空回答会被响亮拒绝');
  });
});

describe('W21-M2 三处同源：CLI 侧认它是写命令 + 认 --dry-run，MCP 侧挂着 dry_run', () => {
  it('M2.1 `ask-apply` 在 `WRITE_COMMANDS` 与 `DRY_RUN_COMMANDS` 里（"apply" 是**写盘**不是渲染）', () => {
    expect(core.WRITE_COMMANDS).toContain('ask-apply');
    expect(core.DRY_RUN_COMMANDS).toContain('ask-apply');
  });

  it('M2.2 映射表与 schema 同源：`DRY_RUN_TOOL_CMD.ask_apply === \'ask-apply\'` 且 schema 挂了 dry_run', () => {
    expect(mcp.DRY_RUN_TOOL_CMD.ask_apply).toBe('ask-apply');
    expect(tool('ask_apply').inputSchema.properties.dry_run).toBeTruthy();
    // 映射表里的每个工具都必须真的在 CLI 的支持集里（与 tests/w8-dry-run.test.js 的 F3 同一条纪律）
    const bad = Object.keys(mcp.DRY_RUN_TOOL_CMD)
      .filter((t) => core.DRY_RUN_COMMANDS.indexOf(mcp.DRY_RUN_TOOL_CMD[t]) < 0);
    expect(bad).toEqual([]);
  });
});

/* ============================================================================
 * 二、真调用：落盘 / 变更日志署名 / 幂等 / 子节点
 * ========================================================================== */
describe('W21-M3 真调用（子进程转发同一个 CLI）', () => {
  it('M3.1 落盘：`qa` 记录 + `detail` 末尾都到位；变更日志的 `writer` 是 `mcp:ask-apply`', () => {
    seed();
    const r = mcp.callTool('ask_apply', {
      project: PROJ, id: 'n-a', question: '为什么是三次握手？', answer: '为了双向确认收发能力。',
      at: '2026-10-20T10:00:00.000Z', model: 'w21-test'
    });
    expect(r.ok, String(r.text)).toBe(true);
    const j = JSON.parse(String(r.text).trim());
    expect(j).toMatchObject({ ok: true, project: PROJ, node: 'n-a', qaIndex: 0, qaCount: 1, duplicate: false });
    const node = readNode('n-a');
    expect(node.qa).toHaveLength(1);
    expect(node.qa[0]).toMatchObject({ q: '为什么是三次握手？', a: '为了双向确认收发能力。', at: '2026-10-20T10:00:00.000Z', model: 'w21-test' });
    expect(String(node.detail)).toContain('原有内容');                    // 追加，**不覆盖**
    expect(String(node.detail)).toContain('为了双向确认收发能力。');       // 新的这一段进去了
    // 变更日志：这一笔是"经 MCP 写的"（`writer` 由 `MM_WRITER` 决定，不参与任何判定，只影响可读性）
    const last = fs.readFileSync(changesFile(), 'utf8').trim().split('\n').pop();
    expect(JSON.parse(last).writer).toBe('mcp:ask-apply');
    expect(JSON.parse(last).changed).toEqual(['node:n-a']);
  });

  /* ⚠️ 幂等的**真实口径**（2026-10-20 实测，别读成"什么都没动"）：
   *   `duplicate:true` 只保证 `qa` 那一半不重复追加；`detail` 是**流水**，
   *   `src/qa.js` 的 `appendToDetail` 注释写明"让重复写入**必然堆叠**而不互相覆盖" ⇒
   *   同一条问答落第二次时 detail 会**再叠一段**（`<hr>` 边界），于是**盘上确实变了**、
   *   变更日志也会多一条。这不是缺陷，是那份单一实现写明的语义；本组把**两个半边**都钉住，
   *   免得有人把它当"完全幂等"来重试（MCP 工具的描述里也写了这一条）。 */
  it('M3.2 幂等只在 `qa` 这一半：`duplicate:true` 且 qa 条数不变；但 detail 会再叠一段（既定语义）', () => {
    seed();
    const args = { project: PROJ, id: 'n-a', answer: '同一个回答', question: '同一个问题', at: '2026-10-20T10:00:00.000Z' };
    expect(mcp.callTool('ask_apply', args).ok).toBe(true);
    const lines1 = fs.readFileSync(changesFile(), 'utf8').trim().split('\n').length;
    const detail1 = String(readNode('n-a').detail);
    const r2 = mcp.callTool('ask_apply', args);
    expect(r2.ok, String(r2.text)).toBe(true);
    expect(JSON.parse(String(r2.text).trim())).toMatchObject({ duplicate: true, qaCount: 1 });
    const node2 = readNode('n-a');
    expect(node2.qa).toHaveLength(1);                                   // ← 幂等的那一半
    expect(String(node2.detail).length).toBeGreaterThan(detail1.length); // ← 会叠（既定语义）
    expect((String(node2.detail).match(/同一个回答/g) || []).length).toBe(2);
    // 盘上变了 ⇒ 变更日志也多一条：**这条断言是"它确实不是完全幂等"的机械证据**（不是猜的）
    expect(fs.readFileSync(changesFile(), 'utf8').trim().split('\n').length).toBe(lines1 + 1);
  });

  it('M3.3 `as_child:true` ⇒ 真的多一个子节点（标题取回答首行），`child` 字段带 id 与标题', () => {
    seed();
    const r = mcp.callTool('ask_apply', {
      project: PROJ, id: 'n-a', answer: '第一行标题\n第二行正文', as_child: true, child_id: 'n-child-1',
      at: '2026-10-20T10:00:00.000Z'
    });
    expect(r.ok, String(r.text)).toBe(true);
    const j = JSON.parse(String(r.text).trim());
    expect(j.child).toMatchObject({ id: 'n-child-1' });
    const child = readNode('n-child-1');
    expect(child).toBeTruthy();
    expect(String(child.topic)).toContain('第一行标题');
    expect(String(child.detail)).toContain('第二行正文');
  });
});

/* ============================================================================
 * 三、预览与失败：都不写盘
 * ========================================================================== */
describe('W21-M4 `dry_run:true` ⇒ 报告得出、一个字节都不写', () => {
  it('M4.1 项目文件 sha256 不变、`.changes.jsonl` 还没被创建；报告里带 `dryRun:true` + `plan`', () => {
    seed();
    const h0 = sha(projFile());
    const hadLog = fs.existsSync(changesFile());
    const r = mcp.callTool('ask_apply', { project: PROJ, id: 'n-a', answer: '预览用回答', dry_run: true });
    expect(r.ok, String(r.text)).toBe(true);
    // `--json` 档里那条"未写盘"的证据是 `dryRun:true` + `plan`（`[dry-run 未写盘]` 那行前缀是**文本档**的；
    // 两种档位各自的判据都在，别拿文本档的标记去判 JSON）
    const j = JSON.parse(String(r.text).trim());
    expect(j.dryRun).toBe(true);
    expect(j.plan.changed).toEqual(['node:n-a']);
    expect(sha(projFile())).toBe(h0);                       // 逐字节不变
    expect(fs.existsSync(changesFile())).toBe(hadLog);       // 变更日志也没被追加
    expect(readNode('n-a').qa).toBeUndefined();              // 数据里真的没有那条记录
  });
});

describe('W21-M5 业务失败 ⇒ `ok:false` 且盘上零改动（空记录比报错危险得多）', () => {
  it('M5.1 空答案 ⇒ 被 CLI **响亮拒绝**（不是协议错误：工具存在、参数也齐）', () => {
    seed();
    const h0 = sha(projFile());
    const r = mcp.callTool('ask_apply', { project: PROJ, id: 'n-a', answer: '   ' });
    expect(r.ok).toBe(false);
    expect(String(r.text)).toContain('回答为空');
    expect(sha(projFile())).toBe(h0);
  });

  it('M5.2 节点不存在 ⇒ 被拒并点名那个 id，盘上零改动', () => {
    seed();
    const h0 = sha(projFile());
    const r = mcp.callTool('ask_apply', { project: PROJ, id: 'n-没有这个', answer: '答案' });
    expect(r.ok).toBe(false);
    expect(String(r.text)).toContain('n-没有这个');
    expect(sha(projFile())).toBe(h0);
  });

  it('M5.3 项目不存在 ⇒ 业务失败（MCP 的 `isError`，不是协议错误）', () => {
    seed();
    const r = mcp.callTool('ask_apply', { project: 'no-such-project-w21', id: 'n-a', answer: '答案' });
    expect(r.ok).toBe(false);
    expect(r.protocol).toBeUndefined();       // 不是 -32602 那类"你调错了"
  });
});

/* ============================================================================
 * 四、协议层还认得出这条工具（真 stdio 一拍的纯逻辑部分）
 * ========================================================================== */
describe('W21-M6 `tools/list` 里看得见它（模型看不见就用不上）', () => {
  it('M6.1 initialize + tools/list 一拍：返回的工具里有 `ask_apply` 且带 dry_run 参数', () => {
    const sent = [];
    mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }, (o) => sent.push(o));
    mcp.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, (o) => sent.push(o));
    expect(sent).toHaveLength(2);
    const list = sent[1].result.tools;
    expect(list).toHaveLength(mcp.TOOLS.length);
    const t = list.filter((x) => x.name === 'ask_apply')[0];
    expect(t).toBeTruthy();
    expect(t.inputSchema.properties.dry_run).toBeTruthy();
  });

  it('M6.2 缺必填参数是**协议级**（-32602），不是 `isError` —— 与业务失败的边界不许混', () => {
    const sent = [];
    mcp.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ask_apply', arguments: { project: PROJ } } }, (o) => sent.push(o));
    expect(sent).toHaveLength(1);
    expect(sent[0].error.code).toBe(mcp.RPC.INVALID_PARAMS);
    expect(sent[0].error.message).toContain('id');
  });

  it('M6.3 CLI 侧那条命令真的在 registry 里（改名/删命令时先红这里）', () => {
    expect(invokeSync(['ask-apply', '--help']).code).toBe(0);
    expect(require('../cli/registry.js').list().map((c) => c.name)).toContain('ask-apply');
  });
});
