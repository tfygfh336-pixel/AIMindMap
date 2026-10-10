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
