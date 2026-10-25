/* ============================================================
 * tests/sidebar-context.test.js — ⑨「送进侧栏」的**投喂单位**编排（纯函数）
 * ------------------------------------------------------------
 * 为什么值得单测：这段文本是**投喂给另一个 AI 的上下文** ⇒ 行数多一行、单位被劈成两行、
 * 或者旧的那段模板句又回来，都很难从界面上看出来 ✗（而它一旦发出去就进了对面的会话历史 ✓）。
 * 所以把"应该长什么样"钉在单测里 ✓ —— 而不是靠肉眼看侧栏输入框 ✓。
 *
 * 2026-10-39 改口径（判据换形态，**格数不减**：7 格 → 7 格）。
 * 旧 7 格钉的是「抬头句 / 编号 / 正文截断 / 结尾模板句」——用户原话推翻了那套形态：
 *   「拖过去两个节点直接弹这么多。不可以直接在对话栏里显示两个"节点链接"吗？」
 * ⇒ 每格都还在，只是**期望值换成新形态**；并新增两类反向判据
 *   （① 旧的模板句**一个都不许再出现**；② 单位数严格等于节点数 —— 多一行就是"又啰嗦了"）。
 * ⚠️ 它是**纯文本不是 chip**（DSH 的真 chip 只能由已注册的 `inputTriggers` source 插入，
 *    页面侧没有口子）—— 所以这里也不许把断言写成"是引用节点"。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sc = require('../src/sidebar-context.js');

/** 旧实现的那几句模板文案（用户明确否掉的那一版）——任何一格都不许再把它们吐出来 */
const OLD_TEMPLATE = [
  '【来自 AI MindMap',
  '以下节点：',
  '以下 ',
  '个节点：',
  '这些是我这边的上下文',
  '你按需回答即可',
  '路径：',
  '标签：',
  '正文',
  '（没有选中任何节点）'
];

/** 一条投喂单位（= 一行、以 @ 开头、不含换行） */
const isUnit = (line) => /^@\S/.test(line) && line.indexOf('\n') < 0;

describe('⑨ 投喂单位：一行一个节点，不许有模板句', () => {
  it('单节点 ⇒ **只有一行** `@项目/标题`（旧的抬头/标签/正文全都不许回来）', () => {
    const t = sc.buildSidebarText('comnet', [{ topic: 'TCP 连接管理', tags: ['网络', 'TCP'], detailText: '三次握手…' }]);
    expect(t).toBe('@comnet/TCP 连接管理');
    expect(t.split('\n').length).toBe(1);          // 单节点就是一份单位，不是"一段话"
    for (const old of OLD_TEMPLATE) expect(t).not.toContain(old);
    expect(t).not.toContain('三次握手');            // 正文不再搬运（改为指针，对面自己查）
    expect(t).not.toContain('网络');                // 标签同理
  });

  it('多节点 ⇒ 单位数**严格等于**节点数，且逐行对得上（不多一行、不合并、不编号）', () => {
    const t = sc.buildSidebarText('comnet', [{ topic: 'A' }, { topic: 'B' }, { topic: 'C' }]);
    const lines = t.split('\n');
    expect(lines).toEqual(['@comnet/A', '@comnet/B', '@comnet/C']);
    expect(lines.length).toBe(3);
    lines.forEach((ln) => expect(isUnit(ln)).toBe(true));
    expect(t).not.toMatch(/^\d+\./m);              // 旧口径的 "1. A" 编号不许回来
  });

  it('标题超长 ⇒ 截断并留 …（**截的只是标题段**，`@项目/` 一定还在）', () => {
    const long = 'x'.repeat(sc.REF_MAX + 500);
    const t = sc.buildSidebarText('p', [{ topic: long }]);
    expect(t.length).toBe(sc.REF_MAX);
    expect(t.endsWith('…')).toBe(true);
    expect(t.startsWith('@p/')).toBe(true);
    expect(t).toContain('x'.repeat(sc.REF_MAX - 10));
    expect(t).not.toContain('x'.repeat(sc.REF_MAX + 1));
  });

  it('标题里的换行/连续空白折成一个空格 ⇒ 一份单位不许被劈成两行', () => {
    const t = sc.buildSidebarText('p', [{ topic: 'a\n\n  b\tc' }]);
    expect(t).toBe('@p/a b c');
    expect(t.split('\n').length).toBe(1);          // 换行归一化 = 行数守得住
    expect(t).not.toContain('undefined');
  });

  it('缺字段不崩、不出现 undefined：无标题给占位词，空/坏元素被滤掉', () => {
    const t = sc.buildSidebarText('p', [{}, null, { topic: 'X' }]);
    expect(t).not.toContain('undefined');
    expect(t).toBe('@p/(无标题)\n@p/X');
    expect(t.split('\n').length).toBe(2);          // 2 个有效节点 ⇒ 2 份单位（null 不占行）
  });

  it('空清单 ⇒ **空串**（不编任何话；由调用方报"没有要送过去的内容"）', () => {
    const t = sc.buildSidebarText('p', []);
    expect(t).toBe('');
    for (const old of OLD_TEMPLATE) expect(t).not.toContain(old);
  });

  it('项目名缺失/空白 ⇒ 降级成 `@标题`（不出现 `undefined`，也不出现 `@?/`）', () => {
    expect(sc.buildSidebarText(undefined, [{ topic: 'T' }])).toBe('@T');
    expect(sc.buildSidebarText('   ', [{ topic: 'T' }])).toBe('@T');
    for (const t of [sc.buildSidebarText(undefined, [{ topic: 'T' }]), sc.buildSidebarText(null, [{ topic: 'T' }])]) {
      expect(t).not.toContain('undefined');
      expect(t).not.toContain('@?');
      expect(t).not.toContain('null');
    }
  });
});
