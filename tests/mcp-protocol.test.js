/* ============================================================
 * tests/mcp-protocol.test.js — MCP（JSON-RPC 2.0）**协议形状**契约
 * ------------------------------------------------------------
 * 守的缺陷（2026-10-10 实测原始报文，非假设）：
 *   未知方法回的是 `{"jsonrpc":"2.0","id":4,"result":"method not found: no-such-method"}` ——
 *   既没有 `error`、也没有 `code`，标准 MCP 客户端按 `result` 处理 ⇒ **静默**（调用方以为成功了）。
 *   根因：`scripts/mcp-server.js` 的默认分支漏传 `isError`（对照 `:477` 那条传了）。
 *
 * 这里钉住**两个方向的边界**（混了都坏事，见脚本里 RPC 表的注释）：
 *   · 协议级（未知方法 / 未知工具 / 缺必填参数）⇒ JSON-RPC `error` + 标准错误码；
 *   · 业务级（工具存在、参数齐，但执行失败）⇒ `result` + `isError: true`（失败原因要让模型看见）。
 *   ⇒ 所以本文件**同时**断言"该报 error 的报 error"和"不该报 error 的**不**报 error"。
 *
 * 不起子进程（受限环境管道 stdio 会 EPERM 假失败）；真 stdio 那一拍在
 * `scripts/cli-integration.js` 的 MCP 协议段（起 `node scripts/mcp-server.js` 发一拍）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mcp = require('../scripts/mcp-server.js');
const { handleMessage, RPC, callTool, TOOLS } = mcp;

/** 收一拍响应（`handleMessage` 的 send 收集器） */
function oneShot(msg) {
  const out = [];
  handleMessage(msg, (o) => out.push(o));
  return out;
}

describe('协议级：未知方法 / 未知工具 / 参数非法 ⇒ JSON-RPC error', () => {
  it('未知方法 ⇒ error -32601，且**没有** result 键（修前是 result 字符串）', () => {
    const out = oneShot({ jsonrpc: '2.0', id: 4, method: 'no-such-method' });
    expect(out).toHaveLength(1);
    expect(out[0].jsonrpc).toBe('2.0');
    expect(out[0].id).toBe(4);
    expect(out[0].result).toBeUndefined();
    expect(out[0].error).toBeTruthy();
    expect(out[0].error.code).toBe(RPC.METHOD_NOT_FOUND);
    expect(out[0].error.code).toBe(-32601);
    expect(out[0].error.message).toContain('method not found');
    expect(out[0].error.message).toContain('no-such-method');
  });

  it('tools/call 未知工具 ⇒ error -32601（含工具名）', () => {
    const out = oneShot({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'no-such-tool', arguments: {} } });
    expect(out[0].result).toBeUndefined();
    expect(out[0].error.code).toBe(-32601);
    expect(out[0].error.message).toContain('no-such-tool');
  });

  it('tools/call 没给工具名 ⇒ error -32602（参数非法，不是"未知方法"）', () => {
    const out = oneShot({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {} });
    expect(out[0].result).toBeUndefined();
    expect(out[0].error.code).toBe(RPC.INVALID_PARAMS);
    expect(out[0].error.code).toBe(-32602);
    expect(out[0].error.message).toContain('缺少工具名');
  });

  it('tools/call 缺必填参数 ⇒ error -32602，并点名缺哪个 + 该工具要求什么', () => {
    const out = oneShot({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'add_node', arguments: { project: 'p' } } });
    expect(out[0].result).toBeUndefined();
    expect(out[0].error.code).toBe(-32602);
    expect(out[0].error.message).toContain('parent');
    expect(out[0].error.message).toContain('topic');
  });

  it('callTool 对未知工具/缺参数返回 protocol 标记（**不是** isError 业务失败）', () => {
    const unknown = callTool('no-such-tool', {});
    expect(unknown.protocol).toBe(true);
    expect(unknown.code).toBe(-32601);
    const missing = callTool('get_node', {});
    expect(missing.protocol).toBe(true);
    expect(missing.code).toBe(-32602);
    expect(missing.text).toContain('project');
  });

  it('必填项判定与工具定义**同源**（用 schema.required，不另写一份清单）', () => {
    TOOLS.forEach((t) => {
      const need = (t.inputSchema && t.inputSchema.required) || [];
      if (!need.length) return;
      const args = {};
      need.slice(1).forEach((k) => { args[k] = 'x'; });      // 少给第一项
      const r = callTool(t.name, args);
      expect(r.protocol).toBe(true);
      expect(r.text).toContain(need[0]);
    });
  });
});

describe('业务级：工具存在、参数齐 ⇒ 仍是 result + isError（不许变成协议错误）', () => {
  it('不存在的项目：result + isError:true，且失败原因在 content 里（模型看得见）', () => {
    const out = oneShot({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'stats', arguments: { project: 'no-such-project-xyz' } }
    });
    expect(out).toHaveLength(1);
    expect(out[0].error).toBeUndefined();
    expect(out[0].result.isError).toBe(true);
    expect(out[0].result.content[0].type).toBe('text');
    expect(String(out[0].result.content[0].text).length).toBeGreaterThan(0);
  });

  it('缺 --topic 这类"CLI 层"的业务失败同样走 result + isError（不是协议错误）', () => {
    const out = oneShot({
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'add_node', arguments: { project: 'no-such-project-xyz', parent: 'root', topic: '' } }
    });
    // topic 为空 ⇒ 被必填校验挡住（协议级）；换成"项目不存在"这条业务失败：
    const out2 = oneShot({
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'add_node', arguments: { project: 'no-such-project-xyz', parent: 'root', topic: 'X' } }
    });
    expect(out[0].error.code).toBe(-32602);
    expect(out2[0].error).toBeUndefined();
    expect(out2[0].result.isError).toBe(true);
    expect(out2[0].result.content[0].text).toBeTruthy();
  });
});

describe('握手与通知（回归：别被上面的改动带坏）', () => {
  it('initialize ⇒ result 含 protocolVersion / capabilities.tools / serverInfo', () => {
    const out = oneShot({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(out[0].error).toBeUndefined();
    expect(out[0].result.protocolVersion).toBe('2024-11-05');
    expect(out[0].result.capabilities.tools).toEqual({});
    expect(out[0].result.serverInfo.name).toBe('ai-mind-map');
  });

  it('ping ⇒ 空 result；tools/list ⇒ 工具清单与 TOOLS 同源', () => {
    expect(oneShot({ jsonrpc: '2.0', id: 2, method: 'ping' })[0].result).toEqual({});
    const list = oneShot({ jsonrpc: '2.0', id: 3, method: 'tools/list' })[0];
    expect(list.result.tools).toHaveLength(TOOLS.length);
  });

  it('通知（无 id）不产生任何响应 —— 包括未知方法（协议规定）', () => {
    expect(oneShot({ jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual([]);
    expect(oneShot({ jsonrpc: '2.0', method: 'no-such-method' })).toEqual([]);
  });

  it('id 为 0 / 空串也照常响应（`id === undefined` 才是通知，不能用 falsy 判）', () => {
    expect(oneShot({ jsonrpc: '2.0', id: 0, method: 'ping' })[0].id).toBe(0);
    expect(oneShot({ jsonrpc: '2.0', id: '', method: 'ping' })[0].id).toBe('');
    expect(oneShot({ jsonrpc: '2.0', id: 0, method: 'no-such-method' })[0].error.code).toBe(-32601);
  });
});

/* ============================================================
 * 工具面**文案**：`search_nodes` 的 desc 必须写上 W6 的两条检索口径
 * ------------------------------------------------------------
 * 为什么钉在 desc 上：`inputSchema` 是机器可读的参数面，而 **desc 是模型唯一读得到的口径** ——
 * 行为改成"命中 = 非连续子序列 + 与命令面板同序"之后，desc 若仍是旧口径（只写"搜条目"），
 * 模型看到模糊命中会当成误召回。**只判文案**：行为由 `tests/search-fuzzy.test.js`（A/B/E2）与
 * `scripts/cli-integration.js` 的 W6 段守着，本组不重复、也不替代它们。
 * 口径边界（照 B8 声明）：本组判"这两条口径写没写进 desc"，**判不了**"写得对不对"。
 * 计数口径：**工具数不写死**，与 `docs/VERIFY.md` 的真值出口逐字对齐（现算）。
 * ============================================================ */
describe('工具面文案：`search_nodes` 的 desc 与检索口径同源（W6 的边界外遗留）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { fileURLToPath } = require('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const searchTool = () => TOOLS.filter((t) => t.name === 'search_nodes')[0];

  it('工具数不变（现算：与 `docs/VERIFY.md` 的真值出口一致）且 `search_nodes` 只有一个', () => {
    const verify = fs.readFileSync(path.join(ROOT, 'docs', 'VERIFY.md'), 'utf8');
    const m = /^\|\s*MCP 工具数\s*\|\s*(\d+)\s*\|/m.exec(verify);
    expect(m, 'docs/VERIFY.md 里必须有「MCP 工具数」那一行（否则这条判据测不了任何东西）').toBeTruthy();
    expect(TOOLS.length, '工具数必须等于真值出口报的那个数（本次只改文案，一格不动）').toBe(Number(m[1]));
    expect(TOOLS.filter((t) => t.name === 'search_nodes'), '同名工具只有一个').toHaveLength(1);
    // 参数面**一格不动**：没有为这两条口径发明新参数；`search_nodes` 仍无必填项（project 自 W1 起可选）
    const props = Object.keys(searchTool().inputSchema.properties || {});
    expect(props.filter((k) => /fuzzy|subsequence|rank|order/i.test(k)), '没有为文案里的口径新增参数').toEqual([]);
    expect(searchTool().inputSchema.required, '必填项没变').toEqual([]);
  });

  it('desc 写明两条 W6 口径：非连续子序列也算命中 + 零热度档与命令面板逐条同序', () => {
    const desc = String(searchTool().description || '');
    // ① 命中口径：非连续子序列（子串是它的特例）
    expect(desc, '正文没写"非连续子序列"这条命中口径').toContain('非连续子序列');
    // ② 顺序口径：可断言形态 = **零热度档**（有热度时会被重排，只写"顺序一致"是过度承诺）
    expect(desc, '正文没写零热度档（"与面板逐条相同"只在没有热度 / no_heat 时成立）').toContain('零热度档');
    expect(desc, '正文没写"逐条相同"这个可断言的顺序口径').toContain('逐条相同');
    // 两条口径的来源要能被读者追到：面板侧同一个谓词 + 唯一实现处
    expect(desc, '正文没写"与界面命令面板同一个谓词/同一份打分"').toContain('命令面板');
    expect(desc, '正文没点名打分与定序的唯一实现处（读者会以为 AI 侧另有一套排序）').toContain('palette-rank.js');
    // 反例面：旧口径的措辞不该只剩"只搜标题"那半句（命中口径必须写出来）
    expect(desc.indexOf('非连续子序列') < desc.indexOf('item_level'), '命中口径要写在旧口径那句之前').toBe(true);
  });
});
