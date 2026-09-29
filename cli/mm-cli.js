#!/usr/bin/env node
/* ============================================================
 * AI MindMap — 命令行入口（CLI）
 * ------------------------------------------------------------
 * 用法：node cli/mm-cli.js <command> [args...]
 * 查看全部命令：node cli/mm-cli.js --help
 *
 * 本文件现在是**薄壳**：真正的执行逻辑在 `cli/main.js` 的 `invoke()`。
 * 拆开的理由：集成断言原先只能靠 `spawnSync` 起子进程（实测每条 0.73 s 冷启动，
 * 140 条断言 102 s），把入口导出为纯函数后可在**同一进程内**调用 —— 见 `cli/main.js`
 * 顶部说明。命令列表仍由 `cli/registry.js` 登记；每个命令一个文件：
 *   cli/commands/<file>.js，导出 (ctx, args) => void|Promise
 *
 * 输出约定（失败契约，**进程内与子进程两种入口完全一致**）：
 *   - 成功：文本或 --json 的 JSON，退出码 0
 *   - 失败：**退出码非 0**（首选判据，程序化调用看这个）
 *           ＋ stdout 输出 "error: <原因>"（文本辅助判据，人/日志看这个）
 *   历史问题：失败曾与成功一样返回 exit 0，调用方只能靠匹配 "error:" 前缀判断成败 ——
 *   对非 AI 的程序化调用反直觉，且与 validate/validate-all 已有的非 0 退出码相矛盾。
 *   MCP（scripts/mcp-server.js）与主进程（main.js）本就同时检查 status 与前缀，故不受影响。
 * ============================================================ */
'use strict';

const { invoke } = require('./main.js');

// 缓冲后一次性落地：`invoke()` 已把 stdout/stderr 收齐，最终字节与子进程模式一致。
invoke(process.argv.slice(2)).then((r) => {
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.code;
});
