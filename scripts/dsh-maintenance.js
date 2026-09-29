#!/usr/bin/env node
/* ============================================================
 * scripts/dsh-maintenance.js — 运行包维护 CLI（导入/切换/回滚/列表/校验）
 * ------------------------------------------------------------
 * 与 src/dsh-package.js 的关系：本文件只做参数解析与输出，
 * 全部逻辑在 dsh-package.js（可单测）。
 *
 * 用法（userData 取 Electron 目录；独立运行时用 --user-data 指定）：
 *   node scripts/dsh-maintenance.js list    [--user-data <dir>] [--bundled <dir>]
 *   node scripts/dsh-maintenance.js verify  [--user-data <dir>] [--bundled <dir>] [--skip-hashes]
 *   node scripts/dsh-maintenance.js import <包目录> [--user-data <dir>]
 *   node scripts/dsh-maintenance.js rollback [--user-data <dir>]
 * 失败：stderr error: 前缀 + 退出码 1（与 mm-cli 同约定）。
 * ============================================================ */
'use strict';

const path = require('path');
const pkg = require('../src/dsh-package.js');

function fail(msg) { console.error('error: ' + msg); process.exit(1); }

function bundledRoot(args) {
  // 默认：<工程>/vendor/dsh（dev）；打包后由调用方传 --bundled（resources/dsh）
  if (args.bundled) return path.resolve(args.bundled);
  return path.join(__dirname, '..', 'vendor', 'dsh');
}

function userData(args) {
  if (args.userData) return path.resolve(args.userData);
  // Electron 的 userData 默认是 %APPDATA%/<productName>；脚本独立运行时给个明确提示
  const guess = path.join(process.env.APPDATA || process.env.USERPROFILE || '.', 'AI MindMap');
  if (!process.env.APPDATA) {
    console.error('warn: 未检测到 APPDATA，--user-data 未指定，将使用 ' + guess);
  }
  return guess;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user-data' || a === '--bundled') args[a.slice(2).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = argv[++i];
    else if (a === '--skip-hashes') args.skipHashes = true;
    else args._.push(a);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  try {
    if (cmd === 'list') {
      const ud = userData(args);
      const rows = [{ id: 'bundled（应用自带）', path: bundledRoot(args) }];
      const active = require('fs').existsSync(pkg.activePath ? pkg.activePath(ud) : path.join(ud, pkg.RUNTIMES_DIR, pkg.ACTIVE))
        ? pkg.readActive(ud) : null;
      const dir = path.join(ud, pkg.RUNTIMES_DIR);
      const fs = require('fs');
      if (fs.existsSync(dir)) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          try {
            const m = pkg.readManifest(path.join(dir, e.name));
            rows.push({ id: m.id, path: path.join(dir, e.name) });
          } catch (err) { rows.push({ id: e.name + '（manifest 损坏）', path: path.join(dir, e.name) }); }
        }
      }
      console.log(JSON.stringify({ active: active ? active.current : 'bundled(默认)', runtimes: rows }, null, 2));
      return;
    }
    if (cmd === 'verify') {
      const r = pkg.resolveRuntime({
        bundledRoot: bundledRoot(args),
        userDataPath: userData(args),
        verifyHashes: !args.skipHashes
      });
      console.log('OK ' + r.manifest.id + '（source=' + r.source + '，dsh ' + r.manifest.dshVersion
        + '，pnpm ' + r.manifest.pnpmVersion + '）');
      return;
    }
    if (cmd === 'import') {
      const dir = args._[1];
      if (!dir) fail('import 需要 <包目录>');
      const r = pkg.installRuntime(path.resolve(dir), userData(args));
      console.log('已导入并激活: ' + r.id);
      return;
    }
    if (cmd === 'rollback') {
      const a = pkg.rollbackRuntime(userData(args));
      console.log('已回滚到 bundled（previous=' + a.previous + '）');
      return;
    }
    console.log('用法: node scripts/dsh-maintenance.js <list|verify|import|rollback> [...]');
    process.exit(1);
  } catch (e) {
    fail((e.code ? '[' + e.code + '] ' : '') + e.message);
  }
}

main();
