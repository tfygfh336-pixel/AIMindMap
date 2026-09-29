/* ============================================================
 * src/history.js — 快照式撤销/重做栈（UMD：Node + 浏览器双端）
 * ------------------------------------------------------------
 * 用法（浏览器）：
 *   const st = new MMHistory.UndoStack(50);
 *   st.push(jsonString);            // 每次结构修改**后**压入快照（见下方说明）
 *   const prev = st.undo();         // 返回上一快照（无则 null）
 *   const next = st.redo();
 *   st.canUndo(); st.canRedo(); st.clear();
 * 用法（Node）：const { UndoStack } = require('./history.js');
 *
 * **「修改后 push」不是随意约定，写反会导致撤销跳过一档**：
 * 栈里存的应当是"每个已发生的状态"。若按"修改前 push"，栈顶是修改**前**的状态，
 * `undo()` 弹出它得到的是**上上个**状态（实测：栈 [S0,S1]、当前 S2 → undo 返回 S0，
 * 而期望是 S1）。renderer/app-actions.js 的 recordHistory() 即为"修改后 push"。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMHistory = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class UndoStack {
    /**
     * @param {number} limit 最多保留的快照数（0 = 不限制）
     */
    constructor(limit) {
      this.limit = limit > 0 ? limit : 0;
      this._undo = [];
      this._redo = [];
    }

    /** 压入一个快照（通常是 serializeTree() 的 JSON 字符串） */
    push(snapshot) {
      this._undo.push(snapshot);
      if (this.limit && this._undo.length > this.limit) this._undo.shift();
      this._redo.length = 0; // 新操作使重做分支失效
    }

    undo() {
      if (!this._undo.length) return null;
      const cur = this._undo.pop();
      this._redo.push(cur);
      return this._undo.length ? this._undo[this._undo.length - 1] : null;
    }

    redo() {
      if (!this._redo.length) return null;
      const nxt = this._redo.pop();
      this._undo.push(nxt);
      return nxt;
    }

    canUndo() { return this._undo.length > 0; }
    canRedo() { return this._redo.length > 0; }

    clear() {
      this._undo.length = 0;
      this._redo.length = 0;
    }

    get depth() { return this._undo.length; }
  }

  return { UndoStack };
});
