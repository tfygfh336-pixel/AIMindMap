/* ============================================================
 * src/version.js — 语义化版本工具（UMD 纯逻辑）
 * ------------------------------------------------------------
 * 从 cli/commands/release.js 下沉而来：版本号解析与递增是纯函数，
 * 放在 src/ 才能被单测直接覆盖（命令层此前零单测）。
 *
 * 修正的历史缺陷：原实现递增 minor 时**不把 patch 归零**
 *   （0.14.3 + --minor → 0.15.3，语义化版本要求得到 0.15.0），
 *   且 registry 只声明了 --patch/--minor，没有 --major。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMVersion = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RE = /^(\d+)\.(\d+)\.(\d+)$/;

  /** 是否为合法的 x.y.z 版本号 */
  function isValid(v) {
    return RE.test(String(v === undefined || v === null ? '' : v).trim());
  }

  /** 解析为 { major, minor, patch }；非法返回 null */
  function parse(v) {
    const m = RE.exec(String(v === undefined || v === null ? '' : v).trim());
    if (!m) return null;
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
  }

  /**
   * 递增版本号。kind: 'major' | 'minor' | 'patch'（缺省 patch）。
   * **低位一律归零** —— 这是语义化版本的定义，不是可选行为。
   * @returns 新版本字符串；入参非法则返回 null（由调用方决定如何报错）
   */
  function bump(v, kind) {
    const p = parse(v);
    if (!p) return null;
    const k = kind === 'major' || kind === 'minor' || kind === 'patch' ? kind : 'patch';
    if (k === 'major') return (p.major + 1) + '.0.0';
    if (k === 'minor') return p.major + '.' + (p.minor + 1) + '.0';
    return p.major + '.' + p.minor + '.' + (p.patch + 1);
  }

  /** 数值比较：a<b 返回 -1，相等 0，a>b 返回 1；任一非法返回 null */
  function compare(a, b) {
    const x = parse(a), y = parse(b);
    if (!x || !y) return null;
    if (x.major !== y.major) return x.major < y.major ? -1 : 1;
    if (x.minor !== y.minor) return x.minor < y.minor ? -1 : 1;
    if (x.patch !== y.patch) return x.patch < y.patch ? -1 : 1;
    return 0;
  }

  return { isValid, parse, bump, compare };
});
