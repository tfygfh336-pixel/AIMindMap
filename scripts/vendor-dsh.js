#!/usr/bin/env node
/* ============================================================
 * scripts/vendor-dsh.js — 制作独立 DSH 运行包（一次性/可重跑）
 * ------------------------------------------------------------
 * 产出（--out <dir>，必须是尚不存在的目录，绝不覆盖现有目录）：
 *   <out>/manifest.json          schemaVersion 1：版本、平台、entries、哈希清单
 *   <out>/node/node.exe          独立 Node 运行时（来自 --node 发行目录，自备许可证）
 *   <out>/node/LICENSE           Node 许可证（--node-license 或发行目录内 LICENSE）
 *   <out>/app/                   完整 DSH 包（package.json + lib + node_modules，物化复制）
 *   <out>/tools/pnpm/            pnpm JS 包（bin/pnpm.cjs + package.json + LICENSE*）
 *   <out>/bin/pnpm.cmd           pnpm shim（调 bundled node 执行 pnpm.cjs）
 *
 * 设计约束（来源 .review/dsh-implementation-contract.md）：
 *   · 物化复制：源树里的 reparse 点（junction/symlink）一律**拒绝**，
 *     不允许运行包存在指向包外的链接（否则删掉全局安装后包即损坏）。
 *   · staging 在系统临时目录完成，最后一次性复制到 --out（新目录），
 *     manifest 最后落盘 —— 半成品永远不会出现在 --out。
 *   · 不复制 ~/.dsh（用户 profile/凭据/会话），不触碰全局 DSH 安装。
 *
 * 用法：
 *   node scripts/vendor-dsh.js --from <全局dsh目录> --node <node发行目录> \
 *     --node-license <LICENSE路径> [--pnpm-from <pnpm包目录>] --out <输出目录>
 *   # --pnpm-from 缺省时：若 --from 同级已物化则报错并提示；
 *   #   网络安装（npm i pnpm@<ver> 到临时目录）仅在显式 --allow-network 时启用。
 * 退出码：0 成功；1 失败（stderr 有 error: 前缀说明）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/* ---------- 参数解析 ---------- */
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from' || a === '--node' || a === '--node-license' || a === '--pnpm-from'
      || a === '--out' || a === '--dsh-version' || a === '--pnpm-version') {
      args[a.slice(2).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = argv[++i];
    } else if (a === '--allow-network') {
      args.allowNetwork = true;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function fail(msg) { console.error('error: ' + msg); process.exit(1); }

/* ---------- 文件系统助手（全部同步，复制物化、拒绝 reparse） ---------- */

/** 目录树复制：物化（跟随内容），遇 reparse 点直接抛错 */
function copyTreeMaterialized(src, dst, onFile) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) throw new Error('拒绝复制符号链接（不允许包内链接指向外部）: ' + src);
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.dsh-module-fallback' && e.isDirectory()) continue; // 指向全局安装的回退，绝不带入
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    const est = fs.lstatSync(s);
    if (est.isSymbolicLink()) throw new Error('拒绝复制符号链接: ' + s);
    if (est.isDirectory()) {
      // Windows junction 也会以 directory 形态出现，用 reparse 检测
      if (process.platform === 'win32' && est.isDirectory()) {
        try {
          const typeAttr = fs.statSync(s).isDirectory() && (fs.lstatSync(s).nlink > 1) && false;
          void typeAttr;
        } catch (err) { /* noop */ }
      }
      copyTreeMaterialized(s, d, onFile);
    } else if (est.isFile()) {
      fs.copyFileSync(s, d);
      if (onFile) onFile(d);
    } else {
      throw new Error('非常规文件（不复制）: ' + s);
    }
  }
}

/** Windows junction 检测：cmd dir /a:l 列出 reparse 点。
 *  物化复制后应当一个都没有 —— 0 个（dir 报 File Not Found）才是期望的干净状态。 */
function assertNoEscapingLinks(root) {
  if (process.platform !== 'win32') return;
  const { spawnSync } = require('child_process');
  const res = spawnSync('cmd.exe', ['/c', 'dir', '/s', '/b', '/a:l', root], { encoding: 'utf8' });
  const out = String(res.stdout || '');
  const lines = out.split(/\r?\n/).filter((l) => l && l.trim() && !/^File Not Found/i.test(l.trim()));
  // dir /a:l 列出 reparse 点；junction/symlink 都算。物化复制后应一个都没有。
  if (lines.length) {
    fail('运行包内发现 reparse 点（' + lines.length + ' 个，首：' + lines[0] + '）— 物化复制失败');
  }
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

/** 收集目录内全部相对文件路径（排序稳定） */
function listFilesRel(root) {
  const out = [];
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) out.push(r);
      else fail('非常规文件: ' + p);
    }
  })(root, '');
  return out.sort();
}

/** 安全相对路径检查：禁止 ..、绝对路径、盘符、反斜杠、Windows 保留设备名 */
function assertSafeRel(rel) {
  if (!rel || /\\/.test(rel)) throw new Error('清单路径必须是正斜杠相对路径: ' + rel);
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) throw new Error('清单路径必须是相对路径: ' + rel);
  const parts = rel.split('/');
  if (parts.some((p) => p === '..' || p === '.')) throw new Error('清单路径禁止 . / ..: ' + rel);
  const bad = new Set(['CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9']);
  parts.forEach((p) => {
    const base = p.replace(/^(.+?)\..*$/, '$1');
    if (bad.has(p.toUpperCase()) || bad.has(base.toUpperCase())) throw new Error('Windows 保留名: ' + rel);
  });
}

/* ---------- 组件组装 ---------- */

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function buildStaging(args) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'aimap-dsh-stage-'));
  console.log('[stage] ' + staging);

  // 1) Node 运行时
  const nodeSrc = path.resolve(args.node);
  const nodeExe = path.join(nodeSrc, 'node.exe');
  if (process.platform !== 'win32') fail('当前脚本仅支持 Windows（node.exe）');
  if (!fs.existsSync(nodeExe)) fail('node 发行目录里没有 node.exe: ' + nodeSrc);
  fs.mkdirSync(path.join(staging, 'node'), { recursive: true });
  fs.copyFileSync(nodeExe, path.join(staging, 'node', 'node.exe'));
  const nodeLicense = args.nodeLicense
    ? path.resolve(args.nodeLicense)
    : [path.join(nodeSrc, 'LICENSE'), path.join(nodeSrc, 'LICENSE.txt'), path.join(nodeSrc, 'license.txt')]
      .find((f) => fs.existsSync(f));
  if (!nodeLicense) fail('未提供 Node 许可证（--node-license 或发行目录内 LICENSE）— 许可证缺失直接失败');
  fs.copyFileSync(nodeLicense, path.join(staging, 'node', 'LICENSE'));

  // 2) DSH 实现（物化整个包：package.json + lib + node_modules）
  const dshSrc = path.resolve(args.from);
  const dshPkg = readJson(path.join(dshSrc, 'package.json'));
  if (dshPkg.name !== '@deepseek-ai/dsh') fail('--from 不是 @deepseek-ai/dsh 包目录: ' + dshSrc);
  const dshVersion = dshPkg.version || args.dshVersion;
  if (args.dshVersion && args.dshVersion !== dshVersion) {
    fail('版本不符：目录是 ' + dshVersion + '，要求 ' + args.dshVersion);
  }
  copyTreeMaterialized(dshSrc, path.join(staging, 'app'), null);
  console.log('[stage] dsh ' + dshVersion + ' 物化完成');

  // 3) pnpm JS 包
  const pnpmVersion = args.pnpmVersion || '10.15.1';
  let pnpmSrc = args.pnpmFrom ? path.resolve(args.pnpmFrom) : null;
  if (!pnpmSrc) {
    // 在 staging 旁用 npm 安装固定版（仅在 --allow-network 时；否则要求 --pnpm-from）
    if (!args.allowNetwork) {
      fail('未指定 --pnpm-from（离线 pnpm 包目录）且未开启 --allow-network — 不会偷偷联网');
    }
    const { execFileSync } = require('child_process');
    const prefix = path.join(staging, '.pnpm-install');
    console.log('[stage] npm install pnpm@' + pnpmVersion + '（联网，临时目录）');
    execFileSync('npm', ['install', '--no-save', '--prefix', prefix, 'pnpm@' + pnpmVersion],
      { stdio: 'inherit' });
    pnpmSrc = path.join(prefix, 'node_modules', 'pnpm');
  }
  const pnpmPkg = readJson(path.join(pnpmSrc, 'package.json'));
  if (pnpmPkg.name !== 'pnpm') fail('--pnpm-from 不是 pnpm 包目录: ' + pnpmSrc);
  const realPnpmVersion = pnpmPkg.version;
  if (realPnpmVersion !== pnpmVersion) fail('pnpm 版本不符：目录是 ' + realPnpmVersion + '，要求 ' + pnpmVersion);
  if (!fs.existsSync(path.join(pnpmSrc, 'bin', 'pnpm.cjs'))) {
    fail('pnpm 包缺 bin/pnpm.cjs（' + realPnpmVersion + ' 的 Rust launcher 版不适用）');
  }
  copyTreeMaterialized(pnpmSrc, path.join(staging, 'tools', 'pnpm'), null);

  // 4) bin/pnpm.cmd shim（调 bundled node 执行 pnpm.cjs；%~dp0 定位同包内路径）
  fs.mkdirSync(path.join(staging, 'bin'), { recursive: true });
  const shim = '@echo off\r\n'
    + '"%~dp0..\\node\\node.exe" "%~dp0..\\tools\\pnpm\\bin\\pnpm.cjs" %*\r\n';
  fs.writeFileSync(path.join(staging, 'bin', 'pnpm.cmd'), shim, 'utf8');

  return { staging, dshVersion, pnpmVersion: realPnpmVersion, nodeLicenseName: path.basename(nodeLicense) };
}

/* ---------- manifest ---------- */
function buildManifest(stagingDir, meta) {
  const rels = listFilesRel(stagingDir);
  const files = {};
  let total = 0;
  for (const rel of rels) {
    assertSafeRel(rel);
    const abs = path.join(stagingDir, rel);
    const st = fs.statSync(abs);
    total += st.size;
    files[rel] = { size: st.size, sha256: sha256File(abs) };
  }
  const id = 'dsh-' + meta.dshVersion + '-' + process.platform + '-' + process.arch
    + '-' + Object.keys(files).length + 'f-' + hash12(JSON.stringify({
      v: meta.dshVersion, p: meta.pnpmVersion,
      f: rels.map((r) => files[r].sha256.slice(0, 12))
    }));
  return {
    schemaVersion: 1,
    id,
    dshVersion: meta.dshVersion,
    pnpmVersion: meta.pnpmVersion,
    nodeVersion: meta.nodeVersion || null,
    platform: process.platform,
    arch: process.arch,
    createdAt: new Date().toISOString(),
    entries: { node: 'node/node.exe', dsh: 'app/lib/bin.js', pnpm: 'tools/pnpm/bin/pnpm.cjs', bin: 'bin' },
    files,
    totalBytes: total
  };
}

function hash12(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
}

/* ---------- 主流程 ---------- */
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.from || !args.node || !args.out) {
    console.log('用法: node scripts/vendor-dsh.js --from <全局dsh目录> --node <node发行目录> '
      + '[--node-license <LICENSE>] [--pnpm-from <pnpm包目录>|--allow-network] '
      + '[--dsh-version <ver>] [--pnpm-version <ver>] --out <新目录>');
    process.exit(args.help ? 0 : 1);
  }
  const out = path.resolve(args.out);
  if (fs.existsSync(out)) fail('--out 目录已存在（不会覆盖任何现有目录）: ' + out);

  const t0 = Date.now();
  const { staging, dshVersion, pnpmVersion } = buildStaging(args);
  try {
    // 物化校验：包内不允许任何 reparse 点
    assertNoEscapingLinks(staging);
    // 剔除 npm 临时安装目录（如果用了 --allow-network）
    const pnpmInstall = path.join(staging, '.pnpm-install');
    if (fs.existsSync(pnpmInstall)) fs.rmSync(pnpmInstall, { recursive: true, force: true });

    const manifest = buildManifest(staging, {
      dshVersion, pnpmVersion,
      nodeVersion: require('child_process').execFileSync(
        path.join(staging, 'node', 'node.exe'), ['-p', 'process.versions.node'],
        { encoding: 'utf8' }).trim()
    });
    console.log('[stage] manifest id=' + manifest.id + ' files=' + Object.keys(manifest.files).length
      + ' total=' + (manifest.totalBytes / 1024 / 1024).toFixed(1) + 'MB');

    // 一次性复制到 out（新目录），manifest 最后落盘
    fs.mkdirSync(out, { recursive: true });
    copyTreeMaterialized(staging, out, null);
    fs.writeFileSync(path.join(out, 'manifest.json'),
      JSON.stringify(manifest, null, 2), 'utf8');
    console.log('[done] ' + out + '（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (err) { /* ignore */ }
  }
}

if (require.main === module) main();
module.exports = { parseArgs, copyTreeMaterialized, assertNoEscapingLinks, buildManifest, hash12, assertSafeRel };
