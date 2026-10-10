/* ============================================================
 * src/control.js —— 界面控制通道（文件式，**不依赖网络/管道**）
 * ------------------------------------------------------------
 * 用途：让**外部 AI 与内置 DSH 侧栏**能命令正在运行的界面做一件事，典型是
 * "关掉左边思维导图页、只留侧栏"（用户要的那个接口）。人类不需要调用它 —— 人类按 ✕ 就行。
 *
 * 为什么是文件而不是 socket / 命名管道：
 *   · 本机受限环境**禁止程序开命名管道**（本工程实测过 spawn/管道类失败）；
 *   · 网络要走策略代理，localhost 也未必通 ⇒ 两者都会把"能不能用"变成环境问题。
 *   文件 + 轮询是唯一在所有环境里都成立的通道，代价是几百毫秒延迟（这类操作完全够）。
 *
 * 协议（两个小 JSON，都在应用 userData 目录下）：
 *   mm-control.json         调用方写：{ cmd: 'dsh-only', on: true|false, at: '<iso>' }
 *   mm-control-result.json  界面写回：{ cmd, ok, state, at }（调用方据此判定"真生效了"）
 * 口径：**没有回执就等于没生效** —— CLI 会因此报错退出，而不是假装成功（本工程最重的损害类别是静默）。
 *
 * **慢命令的调用方：先用 `dsh-status` 探活，再下慢命令**（`cli/commands/ui.js` 的 `dsh-prefill` 就这么做）。
 * 为什么：`dsh-prefill` 内部可能要把**侧栏服务起起来**（冷启动实测几秒，最坏 ≈12.4s），
 *   于是"界面没在跑"与"界面在跑但慢"在**只看这一个回执**时完全一样（都是没有回执）⇒
 *   调用方只能在"白等满窗口才敢判失败"与"提前放弃、把还在干活说成没响应"之间二选一
 *   （实测修前：失败路径 12.56s，而同批另三条命令 ~3.0s；且 12s 窗口 < app 侧最坏 12.4s ⇒
 *   界面还在干活就会被判"没响应"，那是**假原因**）。
 *   `dsh-status` 是**只读**探针、当场可答（无慢路径）⇒ 有回执 = 界面活着，可以放心等；
 *   没回执 = 真没在跑，立刻报错。这样不必改协议、也不必要求界面升级（旧实例一样适用）。
 *
 * 本模块是**纯文件读写**、不 require electron ⇒ 可被单测与 CLI 同时使用（同一份协议）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const CMD_FILE = 'mm-control.json';
const RESULT_FILE = 'mm-control-result.json';

/** 通道的两个文件路径（baseDir 用应用 userData 目录；CLI 与界面必须推导出同一个） */
function paths(baseDir) {
  return { cmd: path.join(baseDir, CMD_FILE), result: path.join(baseDir, RESULT_FILE) };
}

/** 原子写：先写临时文件再改名（半截文件会被读成"无命令"，但绝不能读成半条命令） */
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* ignore */ }
    throw err;
  }
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch (err) { return null; }   // 不存在 / 半截 / 坏 JSON 一律当作"没有"
}

/** 写一条命令（调用方：CLI / MCP / 任何 AI 的脚本） */
function writeCommand(baseDir, cmd) {
  fs.mkdirSync(baseDir, { recursive: true });
  writeJsonAtomic(paths(baseDir).cmd, cmd);
  return cmd;
}

const readCommand = (baseDir) => readJson(paths(baseDir).cmd);
const readResult = (baseDir) => readJson(paths(baseDir).result);
const writeResult = (baseDir, result) => writeJsonAtomic(paths(baseDir).result, result);

function clearCommand(baseDir) {
  try { fs.rmSync(paths(baseDir).cmd, { force: true }); } catch (err) { /* ignore */ }
}

module.exports = { CMD_FILE, RESULT_FILE, paths, writeCommand, readCommand, writeResult, readResult, clearCommand };
