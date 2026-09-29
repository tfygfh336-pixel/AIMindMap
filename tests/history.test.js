/* ============================================================
 * tests/history.test.js — UndoStack 单元测试（vitest，ESM 语法）
 * 运行：npx vitest run
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { UndoStack } from '../src/history.js';

describe('UndoStack', () => {
  it('push 后可 undo / redo', () => {
    const s = new UndoStack(50);
    s.push('A');
    s.push('B');
    expect(s.canUndo()).toBe(true);
    expect(s.canRedo()).toBe(false);
    expect(s.undo()).toBe('A');
    expect(s.canRedo()).toBe(true);
    expect(s.redo()).toBe('B');
    expect(s.canRedo()).toBe(false);
  });

  it('空栈 undo/redo 返回 null', () => {
    const s = new UndoStack(50);
    expect(s.undo()).toBeNull();
    expect(s.redo()).toBeNull();
    expect(s.canUndo()).toBe(false);
  });

  it('新 push 使 redo 分支失效', () => {
    const s = new UndoStack(50);
    s.push('A');
    s.push('B');
    s.undo();            // 回到 A，redo=[B]
    s.push('C');         // 新操作，redo 清空
    expect(s.canRedo()).toBe(false);
    expect(s.undo()).toBe('A');
    expect(s.redo()).toBe('C');
  });

  it('limit 截断旧快照（保留最近 N 个）', () => {
    const s = new UndoStack(2);
    s.push('1');
    s.push('2');
    s.push('3');          // '1' 被截断
    expect(s.depth).toBe(2);
    expect(s.undo()).toBe('2');   // 回到 '2'（'3' 出栈）
    expect(s.redo()).toBe('3');   // 重做 '3'
    expect(s.depth).toBe(2);
  });

  it('clear 清空', () => {
    const s = new UndoStack(50);
    s.push('A');
    s.clear();
    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(false);
  });

  it('limit=0 不截断', () => {
    const s = new UndoStack(0);
    for (let i = 0; i < 100; i++) s.push('n' + i);
    expect(s.depth).toBe(100);
  });
});
