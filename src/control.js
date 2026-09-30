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
