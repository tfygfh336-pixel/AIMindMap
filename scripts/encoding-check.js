#!/usr/bin/env node
/* ============================================================
 * scripts/encoding-check.js — 文件编码完整性门禁
 * ------------------------------------------------------------
 * 存在理由：本工程第二次全损事故的成因是「用 PowerShell 的
 * Get-Content/Set-Content 读写 UTF-8 文档」——PS 5.1 默认按 GBK 解码，
 * 写回时就把中文变成乱码。事后只在 README 加了一条禁令（散文），
 * 零强制：规则写得再重，也没人能在写坏文件的那一刻被拦住。
 *
 * 本脚本把那条规定变成**结果门禁**：扫描全部文本文件，检查
 *   1) UTF-8 BOM（铁律要求「无 BOM」）
 *   2) U+FFFD 替换字符（解码失败的典型残留）
 *   3) 经典乱码特征（GBK 解码残留 / 未初始化内存 / UTF-8 被按 Latin-1 读）
 * 发现任一即 exit 1。已接入 `npm run verify`。
 *
 * ★ 本脚本会被自己扫描，因此**源码里不允许出现乱码字面量**（特征一律用码点构造，
 *   注释也只描述不举例）—— 否则第一次运行就会把自己报成损坏文件。
 *   这条约束同时也证明了门禁确实在工作：它能抓到自己的输入。
 *
 * ★ 能力边界（必须说清，避免误以为它万能）：
 *   它检查的是**损坏的结果**，不是**违规的动作**。
 *   只读地误用 Get-Content（不写盘）不会留下任何痕迹，本脚本无法发现。
 *   真正会造成数据损坏的是写入路径，那部分能被本脚本抓住。
 *
 * 用法：
 *   node scripts/encoding-check.js          检查（有发现则 exit 1）
 *   node scripts/encoding-check.js --list   同时列出每个被检查的文件
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** 不检查的目录：依赖、VCS、可再生产物、本地备份与临时工作区
 *  vendor/ = 打包进应用的第三方运行时（DSH 独立运行包，2.6万文件；
 *  其内容由 scripts/vendor-dsh.js 以哈希清单锁定，编码完整性由该清单负责） */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'build', 'dist', 'dist-portable',
  'backups', '.tmp-img', '.tmp-svg', 'vendor'
]);

/** 参与检查的文本扩展名（二进制文件一律不在内，避免把图片误判为乱码） */
const TEXT_EXT = ['.md', '.js', '.cjs', '.mjs', '.json', '.html', '.css', '.yml', '.yaml', '.txt', '.svg'];

/** 经典乱码特征。命名清楚是为了报错时能直接告诉人「这是怎么坏的」。
 *
 *  ⚠️ 全部用**码点构造**而非字面量：本脚本自身也要被自己扫描（检测器不应污染
 *  自己的输入）。若把这些乱码字面写进源码，第一次运行就会把自己报成损坏文件。 */
const cp = (...codes) => codes.map((c) => String.fromCharCode(c)).join('');
const MOJIBAKE = [
  { name: 'GBK 解码残留（' + cp(0x9539, 0x65A4, 0x62F7) + '）', re: new RegExp(cp(0x9539, 0x65A4, 0x62F7)) },
  { name: '未初始化内存（' + cp(0x70EB, 0x70EB, 0x70EB) + '）', re: new RegExp(cp(0x70EB, 0x70EB, 0x70EB)) },
  { name: '未初始化内存（' + cp(0x5C6F, 0x5C6F, 0x5C6F) + '）', re: new RegExp(cp(0x5C6F, 0x5C6F, 0x5C6F)) },
  {
    name: 'UTF-8 被按 Latin-1 读（' + cp(0x00E2, 0x20AC) + ' / ' + cp(0x00C3) + '）',
    re: new RegExp(cp(0x00E2, 0x20AC) + '|' + cp(0x00C3) + '[\u00a0-\u00bf\u0080-\u009f]')
  }
];

function collect(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collect(path.join(dir, e.name), out);
    } else if (TEXT_EXT.some((x) => e.name.toLowerCase().endsWith(x))) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function main() {
  const listOnly = process.argv.includes('--list');
  const files = collect(ROOT, []).sort();

  const bom = [];
  const replacement = [];
  const mojibake = [];

  files.forEach((p) => {
    const rel = path.relative(ROOT, p).replace(/\\/g, '/');
    if (listOnly) console.log('  ' + rel);
    const buf = fs.readFileSync(p);
    // 1) BOM：EF BB BF
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) bom.push(rel);
    // toString('utf8') 会把非法字节序列替换成 U+FFFD —— 顺带验证了「能否按 UTF-8 解码」
    const s = buf.toString('utf8');
    if (s.indexOf('\uFFFD') >= 0) replacement.push(rel);
    MOJIBAKE.forEach((m) => { if (m.re.test(s)) mojibake.push(rel + '（' + m.name + '）'); });
  });

  console.log('== encoding-check ==');
  console.log('  已检查文本文件: ' + files.length + ' 个');

  // 健全性：一个都没扫到说明 SKIP/EXT 配错了，不能算「通过」
  if (!files.length) {
    console.error('✗ 未扫描到任何文本文件 —— 配置有误，拒绝通过');
    process.exit(1);
  }

  let bad = false;
  const report = (label, arr, hint) => {
    if (!arr.length) { console.log('  ✓ ' + label + '：无'); return; }
    bad = true;
    console.error('  ✗ ' + label + '：' + arr.length + ' 处');
    arr.forEach((x) => console.error('      ' + x));
    if (hint) console.error('      → ' + hint);
  };

  report('UTF-8 BOM', bom, '铁律要求无 BOM；请以 UTF-8（无 BOM）重新保存这些文件');
  report('U+FFFD 替换字符', replacement, '说明存在无法按 UTF-8 解码的字节，文件很可能已被破坏');
  report('经典乱码特征', mojibake, '多由 PowerShell 5.1 默认 GBK 读写造成；请从备份/轨迹恢复该文件');

  if (bad) {
    console.error('\nencoding-check 失败：存在编码损坏或 BOM');
    console.error('恢复指引见 docs/INCIDENTS.md（事故二）');
    process.exit(1);
  }
  console.log('  ✓ 全部文件为 UTF-8 无 BOM，未发现乱码特征');
  console.log('\nencoding-check 通过');
}

main();
