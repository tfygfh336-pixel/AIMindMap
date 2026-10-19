/* ============================================================
 * src/config.js — 全局常量与默认值（UMD）
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMConfig = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  return {
    APP_NAME: 'AI MindMap',
    APP_VERSION: '0.19.0',
    DATA_FORMAT_VERSION: 2,          // projects/<name>/<name>.json 的 schema 版本
    DEFAULT_UNDO_LIMIT: 50,
    DEFAULT_EXPAND_DEPTH: 3          // 打开项目时默认展开深度
  };
});
