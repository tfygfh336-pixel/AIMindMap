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
 *
 * 2026-10-40 再改口径（**去 `@`**；7 格 → 11 格，只增不减）：
 *   真机上 `@book-80211-guide/` 被 composer 当成引用实体改写（前缀重复 / 标题粘连 / 叠三份）。
 *   `vendor/dsh` 只读源码里能读到：`FOLDER_REF_RE = /(^|\s)(@(?:"[^"\n]*\/|[^\s"]+\/))/g`
 *   ⇒ `@名字/` 在行首或空白之后**正好命中**。所以文案里**一个 `@` 都不留**，
 *   且**行首也不许是 `/`**（`/` 是另一个触发符：「/ 调用指令」）。
 *   ⚠️ 那两条是**护栏**：谁把 `@` 加回来，下面的 `isSafeUnit` 判据立刻红 ✓（格 ⑨ 就是拿它做判别力证明）。
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

/** 一条投喂单位（= 一行、非空、不含 `@`、不以 `/` 或 `@` 开头）。
 *  ⚠️ 判定**走产品导出的那条** `isSafeUnit`（不在断言里手抄规则：手抄＝第二份副本，
 *  规则一改就漂 ✗）；这里只钉"一行 = 一个单位"这件事本身。 */
const isUnit = (line) => typeof line === 'string' && line.trim() !== ''
  && line.indexOf('\n') < 0 && sc.isSafeUnit(line) === true;

describe('⑨ 投喂单位：一行一个节点，不许有模板句', () => {
  it('单节点 ⇒ **只有一行** `项目/标题`（旧的抬头/标签/正文全都不许回来）', () => {
    const t = sc.buildSidebarText('comnet', [{ topic: 'TCP 连接管理', tags: ['网络', 'TCP'], detailText: '三次握手…' }]);
    expect(t).toBe('comnet/TCP 连接管理');
    expect(t.split('\n').length).toBe(1);          // 单节点就是一份单位，不是"一段话"
    for (const old of OLD_TEMPLATE) expect(t).not.toContain(old);
    expect(t).not.toContain('三次握手');            // 正文不再搬运（改为指针，对面自己查）
    expect(t).not.toContain('网络');                // 标签同理
  });

  it('多节点 ⇒ 单位数**严格等于**节点数，且逐行对得上（不多一行、不合并、不编号）', () => {
    const t = sc.buildSidebarText('comnet', [{ topic: 'A' }, { topic: 'B' }, { topic: 'C' }]);
    const lines = t.split('\n');
    expect(lines).toEqual(['comnet/A', 'comnet/B', 'comnet/C']);
    expect(lines.length).toBe(3);
    lines.forEach((ln) => expect(isUnit(ln)).toBe(true));
    expect(t).not.toMatch(/^\d+\./m);              // 旧口径的 "1. A" 编号不许回来
  });

  it('标题超长 ⇒ 截断并留 …（**截的只是标题段**，`项目/` 一定还在）', () => {
    const long = 'x'.repeat(sc.REF_MAX + 500);
    const t = sc.buildSidebarText('p', [{ topic: long }]);
    expect(t.length).toBe(sc.REF_MAX);
    expect(t.endsWith('…')).toBe(true);
    expect(t.startsWith('p/')).toBe(true);
    expect(t).toContain('x'.repeat(sc.REF_MAX - 10));
    expect(t).not.toContain('x'.repeat(sc.REF_MAX + 1));
  });

  it('标题里的换行/连续空白折成一个空格 ⇒ 一份单位不许被劈成两行', () => {
    const t = sc.buildSidebarText('p', [{ topic: 'a\n\n  b\tc' }]);
    expect(t).toBe('p/a b c');
    expect(t.split('\n').length).toBe(1);          // 换行归一化 = 行数守得住
    expect(t).not.toContain('undefined');
  });

  it('缺字段不崩、不出现 undefined：无标题给占位词，空/坏元素被滤掉', () => {
    const t = sc.buildSidebarText('p', [{}, null, { topic: 'X' }]);
    expect(t).not.toContain('undefined');
    expect(t).toBe('p/(无标题)\np/X');
    expect(t.split('\n').length).toBe(2);          // 2 个有效节点 ⇒ 2 份单位（null 不占行）
  });

  it('空清单 ⇒ **空串**（不编任何话；由调用方报"没有要送过去的内容"）', () => {
    const t = sc.buildSidebarText('p', []);
    expect(t).toBe('');
    for (const old of OLD_TEMPLATE) expect(t).not.toContain(old);
  });

  it('项目名缺失/空白 ⇒ 降级成 `标题`（不出现 `undefined`，也不出现 `?/`）', () => {
    expect(sc.buildSidebarText(undefined, [{ topic: 'T' }])).toBe('T');
    expect(sc.buildSidebarText('   ', [{ topic: 'T' }])).toBe('T');
    for (const t of [sc.buildSidebarText(undefined, [{ topic: 'T' }]), sc.buildSidebarText(null, [{ topic: 'T' }])]) {
      expect(t).not.toContain('undefined');
      expect(t).not.toContain('?/');
      expect(t).not.toContain('null');
    }
  });

  /* ── 2026-10-40 新增四格（`@` / `/` 两条护栏 + 行数 + 判别力证明）─────────────── */

  it('⑧ 文案里**一个 `@` 都不许有**（它是 composer 的引用触发符，见文件头引的 FOLDER_REF_RE）', () => {
    const t = sc.buildSidebarText('book-80211-guide', [
      { topic: '全书概览与使用说明' }, { topic: '第一章 无线网络导论' }
    ]);
    expect(t.indexOf('@')).toBe(-1);
    expect(t).toBe('book-80211-guide/全书概览与使用说明\nbook-80211-guide/第一章 无线网络导论');
    /* 标题/项目名里**本来就有** @ 的，也不许漏出去（删掉它，不是转义） */
    expect(sc.buildSidebarText('p', [{ topic: 'a@b' }])).toBe('p/ab');
    expect(sc.buildSidebarText('@p', [{ topic: 'T' }])).toBe('p/T');
    expect(sc.buildSidebarText('p', [{ topic: '@' }])).toBe('p/(无标题)');
  });

  it('⑨ 行首不许是 `/` 或 `@`（`/` 是另一个触发符：「/ 调用指令」）', () => {
    /* 项目名为空 + 标题以 / 开头 ⇒ 装配出来就是 `/api`，正是 `/名字` 的触发形状 */
    expect(sc.buildSidebarText('', [{ topic: '/api 分区' }])).toBe('api 分区');
    for (const t of [
      sc.buildSidebarText('', [{ topic: '/api 分区' }]),
      sc.buildSidebarText(undefined, [{ topic: '@ref' }]),
      sc.buildSidebarText('p', [{ topic: 'T' }])
    ]) {
      for (const ln of t.split('\n')) {
        expect(sc.isSafeUnit(ln)).toBe(true);
        expect(/^[@/]/.test(ln), '行首出现了触发符：' + JSON.stringify(ln)).toBe(false);
      }
    }
  });

  it('⑩ **行数 == 节点数**（用户要的"两个引用单位"：2 个节点 ⇒ 恰好 2 行，不是 1 行也不是 3 行）', () => {
    const pairs = [
      [{ topic: '甲' }],
      [{ topic: '甲' }, { topic: '乙' }],
      [{ topic: '甲' }, { topic: '乙' }, { topic: '丙' }]
    ];
    for (const nodes of pairs) {
      const t = sc.buildSidebarText('p', nodes);
      expect(t.split('\n').length, JSON.stringify(t)).toBe(nodes.length);
    }
    /* 反向：把两行粘成一行（＝真机上那个"标题粘连"）必须被这条判据识别成**行数不符** */
    const glued = sc.buildSidebarText('p', [{ topic: '甲' }, { topic: '乙' }]).replace('\n', '');
    expect(glued.split('\n').length).not.toBe(2);
  });

  it('⑪ **判别力证明**：把 `@` 加回去 / 让行首变成 `/` ⇒ `isSafeUnit` 必须判红', () => {
    /* 这条是本批的**护栏本体**：判据不是恒假（干净的行必须绿），也不是恒真（脏的行必须红）。 */
    const clean = sc.buildSidebarText('p', [{ topic: '甲' }, { topic: '乙' }]);
    clean.split('\n').forEach((ln) => expect(sc.isSafeUnit(ln)).toBe(true));
    /* ① 老形态（上一版就是这样）——前缀 @ */
    expect(sc.isSafeUnit('@p/甲')).toBe(false);
    /* ② 真机截图里那个形态（前缀重复） */
    expect(sc.isSafeUnit('@book-80211-guide/@book-80211-guide/全书概览与使用说明')).toBe(false);
    /* ③ 行首 / */
    expect(sc.isSafeUnit('/p/甲')).toBe(false);
    /* ④ 中段 @（FOLDER_REF_RE 在空白之后也会命中） */
    expect(sc.isSafeUnit('p/甲 @p/乙')).toBe(false);
    /* ⑤ 恒真自证不存在：产品当前输出**没有**任何一行被判红 */
    expect(clean.split('\n').filter((ln) => !sc.isSafeUnit(ln))).toEqual([]);
  });
});
