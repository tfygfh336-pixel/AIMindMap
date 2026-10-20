/* ============================================================
 * src/bundle.js — aimap v1 打包格式（纯逻辑，Node 侧；无 UI 依赖）
 * ------------------------------------------------------------
 * 从 cli/commands/project.js 的 export-json / import-json 下沉而来。
 * 打包格式本身是**对外契约**（用户拿它跨电脑迁移与备份），
 * 因此它的解析与校验规则必须能被单测直接锁住，而不是埋在命令文件里。
 *
 * 格式（aimapVersion 1）：
 *   { aimapVersion: 1, meta, format, data, assets: { "<相对路径>": "<base64>" } }
 *
 * 安全要点：assets 的键是**用户可控字符串**，解包前必须逐个验证它解析后仍在
 * 目标项目目录内，否则 `../../x` 可写出项目外（路径穿越）。见 isSafeRelPath。
 * ============================================================ */
'use strict';

/* ---------- UMD 头（形态照 `docs/ARCHITECTURE.md` §2.3；对照模块 `src/palette-rank.js`）----------
 * 修复前（2026-10-20 实测）：`require('path')` / `require('./tree-utils.js')` 直接写在模块顶层
 * ⇒ 浏览器端加载抛 `ReferenceError: require is not defined`。
 * 本模块有一处真读 Node 内建（`path.resolve` / `path.sep` ⇒ `isSafeRelPath` 的路径穿越防御），
 * 浏览器端**本来就不该**有它 ⇒ 合规做法是**显式守卫**：函数都在，调到就抛一句明确的话。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('path'), require('./tree-utils.js'));
  } else {
    root.MMBundle = factory(nodeTrap('path'), root.MMTree);
  }
  /* 浏览器端的 Node 内建替身：属性一取就得到一个**调用即抛**的函数 —— 模块能加载（双端契约成立），
   * 误用时抛一句明确的话（而不是 `require is not defined` / `Cannot read properties of null`）。 */
  function nodeTrap(name) {
    const no = (prop) => function () {
      throw new Error('src/bundle.js 的 ' + name + '.' + prop + ' 需要 Node 环境（浏览器端没有 ' + name + '，打包读写盘请走 CLI）');
    };
    return new Proxy({}, { get: (_t, prop) => (typeof prop === 'symbol' ? undefined : no(String(prop))) });
  }
})(typeof self !== 'undefined' ? self : this, function (path, tree) {

const AIMAP_VERSION = 1;

/**
 * 收集节点引用的资源相对路径（图片与附件），去重且保持树的深度优先顺序。
 * @returns [{ file, kind: 'image' | 'file' }]
 */
function collectResourceRefs(root) {
  const seen = new Set();
  const out = [];
  tree.walk(root, (n) => {
    (n.images || []).forEach((img) => {
      if (!img.file || seen.has(img.file)) return;
      seen.add(img.file);
      out.push({ file: img.file, kind: 'image' });
    });
    (n.files || []).forEach((f) => {
      if (!f.file || seen.has(f.file)) return;
      seen.add(f.file);
      out.push({ file: f.file, kind: 'file' });
    });
  });
  return out;
}

/** 组装 aimap 打包对象（assets 为 { 相对路径: base64 }；由调用方读盘后传入）
 *
 *  **必须带上 assoc（关联笔记）**：它是项目级可选集合，不属于节点树，
 *  若这里漏掉，`export-json → import-json` 这条"无损备份/迁移"路径会静默丢掉全部关联笔记，
 *  而文档一直承诺它是无损的。仅在非空时写入，保持旧包形状不变。
 */
function buildBundle(data, assets) {
  const out = {
    aimapVersion: AIMAP_VERSION,
    meta: data.meta,
    format: data.format,
    data: data.data,
    assets: assets || {}
  };
  if (Array.isArray(data.assoc) && data.assoc.length) out.assoc = data.assoc;
  return out;
}

/**
 * 解析并做**结构层面**的校验（不校验节点树内容 —— 那由 schema 闸门负责）。
 * @returns { ok: true, bundle } 或 { ok: false, error }
 */
function parseBundle(raw) {
  let obj;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw.replace(/^\uFEFF/, '')); }
    catch (e) { return { ok: false, error: 'JSON 解析失败: ' + e.message }; }
  } else {
    obj = raw;
  }
  if (!obj || typeof obj !== 'object') return { ok: false, error: '不是有效的 aimap 打包文件（内容不是对象）' };
  if (obj.aimapVersion !== AIMAP_VERSION) {
    return { ok: false, error: '不是有效的 aimap 打包文件（缺少 aimapVersion:' + AIMAP_VERSION + '）' };
  }
  if (!obj.meta || !obj.meta.name || !obj.data) return { ok: false, error: '打包文件缺少 meta/data' };
  return { ok: true, bundle: obj };
}

/**
 * 相对路径是否安全地落在 baseDir **内部**（严格内部，等于 baseDir 本身也不允许）。
 * 用 path.resolve 归一化后再比较前缀 —— 这样 `a/../../../etc/x`、绝对路径、
 * 以及 Windows 盘符切换都会被挡住。
 *
 * 说明：原实现允许解析结果**恰好等于** baseDir（如 `assets/..`）。那虽不会写出
 * 项目外，但随后会试图把文件写到目录上，属无意义行为；这里一并拒绝。
 */
function isSafeRelPath(baseDir, rel) {
  if (typeof rel !== 'string' || !rel) return false;
  const base = path.resolve(baseDir);
  const p = path.resolve(baseDir, rel);
  return p.indexOf(base + path.sep) === 0;
}

/** 资源引用里，从 root 算起每个 file 的出现次数（用于诊断"同一文件被多处引用"） */
function resourceUsageCount(root) {
  const counts = {};
  tree.walk(root, (n) => {
    (n.images || []).forEach((i) => { if (i.file) counts[i.file] = (counts[i.file] || 0) + 1; });
    (n.files || []).forEach((f) => { if (f.file) counts[f.file] = (counts[f.file] || 0) + 1; });
  });
  return counts;
}

return {
  AIMAP_VERSION, collectResourceRefs, buildBundle, parseBundle, isSafeRelPath, resourceUsageCount
};
});
