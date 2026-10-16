/* ============================================================
 * tests/assoc.test.js — 「关联笔记」实体纯逻辑单元测试（vitest）
 * ------------------------------------------------------------
 * 为什么需要独立实体（而不是把笔记挂在 links 上）是可验证的事实：
 *   · links 是逐条声明有向边 → 图能表达三角，但表达不了"一个对象"
 *   · 挂在 links 上时重跑 link 会整个替换链接对象 → note 丢失
 * 本文件锁住实体自身的解析/校验/查询语义；"note 会丢"那件事由
 * tests/relations.test.js 与 CLI 集成断言各自覆盖。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import assoc from '../src/assoc.js';

const { parseMembers, includes, forNode, memberLabel, autoTitle, validateAssoc, validateAll, genId, MIN_MEMBERS } = assoc;

describe('assoc.parseMembers', () => {
  it('逗号分隔，默认归属本项目', () => {
    expect(parseMembers('a,b', 'P')).toEqual({
      ok: true, members: [{ project: 'P', id: 'a' }, { project: 'P', id: 'b' }]
    });
  });

  it('支持 项目/节点id 的跨项目写法', () => {
    expect(parseMembers('x/y,z', 'P')).toEqual({
      ok: true, members: [{ project: 'x', id: 'y' }, { project: 'P', id: 'z' }]
    });
    expect(parseMembers('comnet/dns,comnet/tcp-basics', 'P').members).toEqual([
      { project: 'comnet', id: 'dns' }, { project: 'comnet', id: 'tcp-basics' }
    ]);
  });

  it('接受数组与选项对象形式（幂等复用）', () => {
    expect(parseMembers(['a', 'b'], 'P').ok).toBe(true);
    const asObj = [{ project: 'P', id: 'a' }, { project: 'P', id: 'b' }];
    expect(parseMembers(asObj, 'P').members).toEqual(asObj);
  });

  it('重复成员自动去重（不是错误）', () => {
    expect(parseMembers('a,a,b', 'P').members).toEqual([
      { project: 'P', id: 'a' }, { project: 'P', id: 'b' }
    ]);
  });

  it('去重后不足 2 个才算错（同一成员写两遍）', () => {
    const r = parseMembers('a,a', 'P');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/至少需要 2 个/);
  });

  it('成员 id 不合规范时报错（沿用节点 id 规则）', () => {
    expect(parseMembers('a,BAD ID', 'P').ok).toBe(false);
    expect(parseMembers('a,Bad_ID', 'P').ok).toBe(false);   // 大写/下划线不合规范
    expect(parseMembers('a,中文', 'P').ok).toBe(false);
    expect(parseMembers('a,Bad_ID', 'P').error).toMatch(/不合规范/);
  });

  it('忽略空 token 与首尾空白', () => {
    expect(parseMembers(' a , , b ', 'P').members).toEqual([
      { project: 'P', id: 'a' }, { project: 'P', id: 'b' }
    ]);
  });

  it('空输入/无输入报"至少 2 个"', () => {
    expect(parseMembers('', 'P').ok).toBe(false);
    expect(parseMembers(undefined, 'P').ok).toBe(false);
    expect(parseMembers(null, 'P').ok).toBe(false);
    expect(parseMembers('', 'P').error).toMatch(/至少需要 2 个/);
  });

  it('MIN_MEMBERS 为 2', () => {
    expect(MIN_MEMBERS).toBe(2);
  });
});

describe('assoc 查询', () => {
  const list = [
    { id: 'a-1', title: '三角', members: [{ project: 'P', id: 'a' }, { project: 'P', id: 'b' }, { project: 'P', id: 'c' }] },
    { id: 'a-2', title: '跨项目', members: [{ project: 'P', id: 'b' }, { project: 'Q', id: 'z' }] }
  ];

  it('includes 判断成员关系（含跨项目）', () => {
    expect(includes(list[0], 'P', 'a')).toBe(true);
    expect(includes(list[0], 'P', 'z')).toBe(false);
    expect(includes(list[1], 'Q', 'z')).toBe(true);
    expect(includes(null, 'P', 'a')).toBe(false);
  });

  it('forNode 取某节点所属的全部关联（多者因此都能进入同一页）', () => {
    expect(forNode(list, 'P', 'a').map((x) => x.id)).toEqual(['a-1']);
    expect(forNode(list, 'P', 'b').map((x) => x.id)).toEqual(['a-1', 'a-2']);
    expect(forNode(list, 'P', 'c').map((x) => x.id)).toEqual(['a-1']);
    expect(forNode(list, 'Q', 'z').map((x) => x.id)).toEqual(['a-2']);
    expect(forNode(list, 'P', 'nope')).toEqual([]);
    expect(forNode(null, 'P', 'a')).toEqual([]);
  });

  it('memberLabel 优先主题，解析不到回退成 项目/id', () => {
    const topicOf = (p, id) => (p === 'P' && id === 'a' ? '甲' : null);
    expect(memberLabel({ project: 'P', id: 'a' }, topicOf)).toBe('甲');
    expect(memberLabel({ project: 'P', id: 'b' }, topicOf)).toBe('P/b');
    expect(memberLabel({ project: 'P', id: 'b' }, null)).toBe('P/b');
  });

  it('autoTitle 用成员主题拼标题（作者没写标题时的兜底）', () => {
    const topicOf = (p, id) => ({ a: '甲', b: '乙', c: '丙' }[id] || null);
    expect(autoTitle(list[0], topicOf)).toBe('甲 ↔ 乙 ↔ 丙');
  });

  it('genId 生成不与现有重复的 id', () => {
    const id = genId(list);
    expect(id).not.toBe('a-1');
    expect(id).not.toBe('a-2');
    expect(assoc.ID_RE.test(id)).toBe(true);
    /* 连续生成也不重复。
     * ⚠️ 这里**必须往 `many` 里放"带 id 的对象"**，不能放裸字符串：`genId(existing)` 的
     * `have` 是从 `existing.map(a => a && a.id)` 建的 —— 传字符串数组等于**每一次都传空**，
     * 于是"不与现有重复"这条保证根本没被用上，唯一性完全押在"毫秒 + 4 位随机"的运气上
     * ⇒ 机器一忙就偶发假红（实测：全链负载下一次 `expected 49 to be 50`；单独跑永远绿）。
     * 改成对象数组之后，这个用例**真的**在测 `genId` 的查重分支（判据变严，不是放宽）。 */
    const many = []; for (let i = 0; i < 50; i++) many.push({ id: genId(many) });
    expect(new Set(many.map((x) => x.id)).size).toBe(50);
  });
});

describe('assoc 校验', () => {
  const good = { id: 'a-1', title: 't', members: [{ project: 'P', id: 'a' }, { project: 'P', id: 'b' }], note: '<p>x</p>' };

  it('合法对象通过', () => {
    expect(validateAssoc(good, 0).ok).toBe(true);
  });

  it('成员少于 2 报错', () => {
    const r = validateAssoc({ id: 'a-1', members: [{ project: 'P', id: 'a' }] }, 0);
    expect(r.ok).toBe(false);
    expect(r.errors.join(';')).toMatch(/至少需要 2 个成员/);
  });

  it('成员重复报错并指出位置', () => {
    const r = validateAssoc({ id: 'a-1', members: [{ project: 'P', id: 'a' }, { project: 'P', id: 'a' }] }, 2);
    expect(r.ok).toBe(false);
    expect(r.errors.join(';')).toMatch(/assoc\[2\]\.members\[1\] 重复成员/);
  });

  it('缺 id / id 不规范报错', () => {
    expect(validateAssoc({ members: good.members }, 0).errors.join(';')).toMatch(/缺少 id/);
    expect(validateAssoc({ id: 'Bad_ID', members: good.members }, 0).errors.join(';')).toMatch(/不合规范/);
  });

  it('members 非数组 / 元素不是对象报错', () => {
    expect(validateAssoc({ id: 'a-1', members: 'x' }, 0).errors.join(';')).toMatch(/members 必须是数组/);
    expect(validateAssoc({ id: 'a-1', members: [null, { project: 'P', id: 'a' }] }, 0).errors.join(';')).toMatch(/不是对象/);
  });

  it('成员缺 project/id 报错', () => {
    expect(validateAssoc({ id: 'a-1', members: [{ id: 'a' }, { id: 'b' }] }, 0).errors.join(';')).toMatch(/缺少 project/);
    expect(validateAssoc({ id: 'a-1', members: [{ project: 'P' }, { project: 'P' }] }, 0).errors.join(';')).toMatch(/缺少 id/);
  });

  it('title/note 类型错误报错（note 必须是 HTML 字符串）', () => {
    expect(validateAssoc({ id: 'a-1', title: 1, members: good.members }, 0).errors.join(';')).toMatch(/title 必须是字符串/);
    expect(validateAssoc({ id: 'a-1', note: {}, members: good.members }, 0).errors.join(';')).toMatch(/note 必须是字符串/);
  });

  it('非对象整体报错', () => {
    expect(validateAssoc(null, 3).errors.join(';')).toMatch(/assoc\[3\] 不是对象/);
  });

  it('validateAll：undefined/null 视为"没有关联"（合法，向后兼容）', () => {
    expect(validateAll(undefined).ok).toBe(true);
    expect(validateAll(null).ok).toBe(true);
    expect(validateAll([]).ok).toBe(true);
  });

  it('validateAll：非数组报错', () => {
    expect(validateAll({}).ok).toBe(false);
    expect(validateAll({}).errors.join(';')).toMatch(/assoc 必须是数组/);
  });

  it('validateAll：重复 id 报错', () => {
    const r = validateAll([good, { ...good }]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(';')).toMatch(/重复 id: a-1/);
  });

  it('validateAll：汇总多个对象的错误（不只报第一个）', () => {
    const r = validateAll([
      { id: 'a-1', members: [{ project: 'P', id: 'a' }] },
      { id: 'a-2', members: [{ project: 'P', id: 'a' }, { project: 'P', id: 'a' }] }
    ]);
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('assoc.pruneMembers', () => {
  const { pruneMembers } = assoc;
  const list = [
    { id: 'a-1', members: [{ project: 'P', id: 'a' }, { project: 'P', id: 'b' }, { project: 'P', id: 'c' }] },
    { id: 'a-2', members: [{ project: 'P', id: 'a' }, { project: 'P', id: 'b' }] },
    { id: 'a-3', members: [{ project: 'Q', id: 'x' }, { project: 'Q', id: 'y' }] }
  ];
  const dropA = (m) => m.project === 'P' && m.id === 'a';

  it('剪掉命中成员，其余保持不变（N 元关联仍成立）', () => {
    const r = pruneMembers(list, dropA);
    expect(r.list[0].members.map((m) => m.id)).toEqual(['b', 'c']);
    expect(r.touched).toEqual([{ id: 'a-1', removed: 1 }]);
  });

  it('剪到不足 2 个成员时整篇关联被删掉（只剩一方不成为"关联"）', () => {
    const r = pruneMembers(list, dropA);
    expect(r.dropped).toEqual(['a-2']);
    expect(r.list.map((a) => a.id)).toEqual(['a-1', 'a-3']);
  });

  it('未命中的关联按原引用带回（不无谓复制）', () => {
    const r = pruneMembers(list, dropA);
    expect(r.list[1]).toBe(list[2]);
  });

  it('跨项目同名 id 不会被误剪（这正是用谓词而非 id 集合的原因）', () => {
    const r = pruneMembers(list, (m) => m.project === 'P' && m.id === 'a');
    expect(r.list.find((a) => a.id === 'a-3').members.map((m) => m.id)).toEqual(['x', 'y']);
  });

  it('没有命中时 changed=false（调用方据此跳过写盘）', () => {
    const r = pruneMembers(list, () => false);
    expect(r.changed).toBe(false);
    expect(r.empty).toBe(false);
    // 返回的是新数组（纯函数不改共享状态），但**每个实体都是原引用**，没有无谓复制
    expect(r.list).toEqual(list);
    r.list.forEach((a, i) => expect(a).toBe(list[i]));
  });

  it('全部清空时 empty=true（调用方据此删掉 assoc 键）', () => {
    const r = pruneMembers([{ id: 'a-1', members: [{ project: 'P', id: 'a' }, { project: 'P', id: 'b' }] }], dropA);
    expect(r.empty).toBe(true);
    expect(r.dropped).toEqual(['a-1']);
  });

  it('不改入参（纯函数）', () => {
    const before = JSON.stringify(list);
    pruneMembers(list, dropA);
    expect(JSON.stringify(list)).toBe(before);
  });

  it('容错：非数组 / members 非数组 / 谓词非函数都不炸', () => {
    expect(pruneMembers(null, dropA).list).toEqual([]);
    expect(pruneMembers([{ id: 'a-1' }], dropA).changed).toBe(false);
    expect(pruneMembers(list).changed).toBe(false);
  });
});
