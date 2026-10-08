/* ============================================================
 * tests/sidebar-context.test.js — ⑨「送进侧栏」的文本编排（纯函数）
 * ------------------------------------------------------------
 * 为什么值得单测：这段文本是**投喂给另一个 AI 的上下文** ⇒ 内容少一项、编号乱一次、
 * 正文没截断，都很难从界面上看出来 ✗（而它一旦发出去就进了对面的会话历史 ✓）。
 * 所以把"应该长什么样"钉在单测里 ✓ —— 而不是靠肉眼看侧栏输入框 ✓。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sc = require('../src/sidebar-context.js');

describe('⑨ 侧栏文本：结构、编号、截断', () => {
  it('单节点：抬头说"以下节点"，正文与标签齐全', () => {
    const t = sc.buildSidebarText('comnet', [{ topic: 'TCP 连接管理', tags: ['网络', 'TCP'], detailText: '三次握手…' }]);
    expect(t).toContain('【来自 AI MindMap·comnet】以下节点：');
    expect(t).toContain('TCP 连接管理');
    expect(t).toContain('标签：网络、TCP');
    expect(t).toContain('正文：三次握手…');
    expect(t).not.toContain('1. TCP');           // 单节点不加编号 ✓
  });

  it('多节点：抬头写明个数，且**逐个编号**（对面 AI 才能对上号 ✓）', () => {
    const t = sc.buildSidebarText('comnet', [{ topic: 'A' }, { topic: 'B' }, { topic: 'C' }]);
    expect(t).toContain('以下 3 个节点');
    expect(t).toContain('1. A');
    expect(t).toContain('2. B');
    expect(t).toContain('3. C');
  });

  it('正文超长 ⇒ **截断并标明**（不能悄悄砍掉还装作完整 ✗）', () => {
    const long = 'x'.repeat(sc.DETAIL_MAX + 500);
    const t = sc.buildSidebarText('p', [{ topic: 'T', detailText: long }]);
    expect(t).toContain('正文（截断）：');
    expect(t).toContain('x'.repeat(sc.DETAIL_MAX));
    expect(t).not.toContain('x'.repeat(sc.DETAIL_MAX + 1));
  });

  it('空白归一化：正文里的换行/连续空格压成单个空格（侧栏输入框里才好读 ✓）', () => {
    const t = sc.buildSidebarText('p', [{ topic: 'T', detailText: 'a\n\n  b\tc' }]);
    expect(t).toContain('正文：a b c');
  });

  it('缺字段不崩、不出现 undefined：无标题/无标签/无正文都各有一份兜底 ✓', () => {
    const t = sc.buildSidebarText('p', [{}, null, { topic: 'X' }]);
    expect(t).not.toContain('undefined');
    expect(t).toContain('(无标题)');
    expect(t).toContain('X');
  });

  it('空清单：如实写"没有选中任何节点"（而不是给对面一段空上下文 ✗）', () => {
    const t = sc.buildSidebarText('p', []);
    expect(t).toContain('（没有选中任何节点）');
    expect(t).toContain('你按需回答即可');
  });

  it('项目名缺失 ⇒ 用 ? 兜底（不出现 undefined ✓）', () => {
    const t = sc.buildSidebarText(undefined, [{ topic: 'T' }]);
    expect(t).toContain('·?】');
    expect(t).not.toContain('undefined');
  });
});
