/* ============================================================
 * tests/schema.test.js — 数据校验单元测试（vitest）
 * 覆盖：环检测（历史栈溢出 bug）、重复 id、字段校验、正常树
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';
import {
  validateProject, migrateNodeOffsets, OFFSET_KEYS, OFFSET_LIMIT, validateOffsetMap,
  // G-15 下沉：`validateProject` 拆出的两个**纯核心**（喂对象就够）+ 读盘注入点的默认实现
  validateInPlace, validateCrossRefs, makeProjectReader
} from '../src/schema.js';
import { renderDetail } from '../src/item-model.js';

/** 仓库的**真实**项目根（只读；`makeProjectReader` 那一组拿它当"盘上真有什么"的夹具） */
const REAL_PROJECTS = fileURLToPath(new URL('../projects', import.meta.url));

/** 收尾只此一处（`tests/_tmp-cleanup.js` 的形态：创建即登记） */
afterAll(cleanupAll);

const wrap = (data, meta) => ({ meta: meta || { name: 'x' }, format: 'node_tree', data });

describe('schema.validateProject', () => {
  it('正常树通过', () => {
    const v = validateProject(wrap({ id: 'root', topic: 'R', children: [
      { id: 'a', topic: 'A', detail: '<p>d</p>', images: [{ file: 'assets/x.png', caption: '图说明' }] }
    ] }), null);
    expect(v.ok).toBe(true);
  });

  it('检测环（修复前会栈溢出）', () => {
    const a = { id: 'a', topic: 'A', children: [] };
    const b = { id: 'b', topic: 'B', children: [] };
    a.children.push(b); b.children.push(a);
    const v = validateProject(wrap(a), null);
    expect(v.ok).toBe(false);
    expect(v.errors.join(';')).toMatch(/环/);
  });

  it('检测重复 id', () => {
    const v = validateProject(wrap({ id: 'root', topic: 'R', children: [
      { id: 'x', topic: 'X' }, { id: 'x', topic: 'X2' }
    ] }), null);
    expect(v.ok).toBe(false);
    expect(v.errors.join(';')).toMatch(/重复 id: x/);
  });

  it('拒绝非法 id 与缺 topic', () => {
    const v = validateProject(wrap({ id: 'Bad ID', topic: 'R' }), null);
    expect(v.errors.join(';')).toMatch(/id 不合规范/);
    const v2 = validateProject(wrap({ id: 'a', topic: '  ' }), null);
    expect(v2.errors.join(';')).toMatch(/topic/);
  });

  it('images 缺 caption 拒绝（AI 理解图片的备注必填）', () => {
    const v = validateProject(wrap({ id: 'root', topic: 'R', images: [{ file: 'assets/x.png' }] }), null);
    expect(v.ok).toBe(false);
    expect(v.errors.join(';')).toMatch(/caption/);
  });

  it('files 附件数组校验（file/caption 必填，合法通过）', () => {
    const ok = validateProject(wrap({ id: 'root', topic: 'R', files: [{ file: 'attachments/a.md', caption: 'RFC 原文' }] }), null);
    expect(ok.ok).toBe(true);
    const bad1 = validateProject(wrap({ id: 'root', topic: 'R', files: [{ caption: '缺 file' }] }), null);
    expect(bad1.ok).toBe(false);
    expect(bad1.errors.join(';')).toMatch(/files\[0\] 缺少 file/);
    const bad2 = validateProject(wrap({ id: 'root', topic: 'R', files: [{ file: 'attachments/a.md' }] }), null);
    expect(bad2.ok).toBe(false);
    expect(bad2.errors.join(';')).toMatch(/files\[0\] 缺少 caption/);
    const bad3 = validateProject(wrap({ id: 'root', topic: 'R', files: 'attachments/a.md' }), null);
    expect(bad3.ok).toBe(false);
    expect(bad3.errors.join(';')).toMatch(/files 必须是数组/);
  });

  it('tags 合法数组通过；非法类型/空串拒绝', () => {
    const ok1 = validateProject(wrap({ id: 'root', topic: 'R', tags: ['协议', '核心'] }), null);
    expect(ok1.ok).toBe(true);
    const ok2 = validateProject(wrap({ id: 'root', topic: 'R', tags: [] }), null);
    expect(ok2.ok).toBe(true);
    const bad1 = validateProject(wrap({ id: 'root', topic: 'R', tags: '协议' }), null);
    expect(bad1.ok).toBe(false);
    expect(bad1.errors.join(';')).toMatch(/tags 必须是数组/);
    const bad2 = validateProject(wrap({ id: 'root', topic: 'R', tags: ['', '  '] }), null);
    expect(bad2.ok).toBe(false);
    expect(bad2.errors.join(';')).toMatch(/非空字符串/);
  });

  it('meta.layout 主题布局校验：合法通过，非法拒绝', () => {
    const ok = validateProject({ meta: { name: 'x', layout: { left: ['a'], right: ['b'] } }, format: 'node_tree',
      data: { id: 'root', topic: 'R', children: [{ id: 'a', topic: 'A' }, { id: 'b', topic: 'B' }] } }, null);
    expect(ok.ok).toBe(true);
    const bad1 = validateProject({ meta: { name: 'x', layout: 'left' }, format: 'node_tree', data: { id: 'root', topic: 'R' } }, null);
    expect(bad1.ok).toBe(false);
    expect(bad1.errors.join(';')).toMatch(/meta\.layout 必须是对象/);
    const bad2 = validateProject({ meta: { name: 'x', layout: { left: 'a' } }, format: 'node_tree', data: { id: 'root', topic: 'R' } }, null);
    expect(bad2.ok).toBe(false);
    expect(bad2.errors.join(';')).toMatch(/meta\.layout\.left 必须是数组/);
    const bad3 = validateProject({ meta: { name: 'x', layout: { right: ['Bad ID'] } }, format: 'node_tree', data: { id: 'root', topic: 'R' } }, null);
    expect(bad3.ok).toBe(false);
    expect(bad3.errors.join(';')).toMatch(/meta\.layout\.right 含非法 id/);
  });

  it('meta.themeOffsets 树偏移校验：合法通过，非法/越界拒绝', () => {
    // 合法：顶层主题 a 偏移 (120,-40)；零偏移项与不存在的 id 由**视图层**负责不写回，
    // schema 只判形状（这里 id 是合法的就通过）
    const ok = validateProject({ meta: { name: 'x', themeOffsets: { a: { x: 120, y: -40 } } }, format: 'node_tree',
      data: { id: 'root', topic: 'R', children: [{ id: 'a', topic: 'A' }] } }, null);
    expect(ok.ok).toBe(true);
    // 缺省（老文件）必须照样通过 —— 它是可选字段，且 formatVersion 不升
    const none = validateProject({ meta: { name: 'x' }, format: 'node_tree', data: { id: 'root', topic: 'R' } }, null);
    expect(none.ok).toBe(true);

    const bad1 = validateProject({ meta: { name: 'x', themeOffsets: [1] }, format: 'node_tree', data: { id: 'root', topic: 'R' } }, null);
    expect(bad1.ok).toBe(false);
    expect(bad1.errors.join(';')).toMatch(/meta\.themeOffsets 必须是对象/);

    const bad2 = validateProject({ meta: { name: 'x', themeOffsets: { 'Bad ID': { x: 1, y: 1 } } }, format: 'node_tree', data: { id: 'root', topic: 'R' } }, null);
    expect(bad2.ok).toBe(false);
    expect(bad2.errors.join(';')).toMatch(/meta\.themeOffsets 含非法 id/);

    const bad3 = validateProject({ meta: { name: 'x', themeOffsets: { a: 5 } }, format: 'node_tree', data: { id: 'root', topic: 'R' } }, null);
    expect(bad3.ok).toBe(false);
    expect(bad3.errors.join(';')).toMatch(/meta\.themeOffsets\.a 必须是 \{x,y\} 对象/);

    const bad4 = validateProject({ meta: { name: 'x', themeOffsets: { a: { x: '1', y: 0 } } }, format: 'node_tree', data: { id: 'root', topic: 'R' } }, null);
    expect(bad4.ok).toBe(false);
    expect(bad4.errors.join(';')).toMatch(/meta\.themeOffsets\.a\.x 必须是有限数字/);

    // 越界护栏：坏数据不能把内容推到视口外再也找不回来
    const bad5 = validateProject({ meta: { name: 'x', themeOffsets: { a: { x: 20001, y: 0 } } }, format: 'node_tree', data: { id: 'root', topic: 'R' } }, null);
    expect(bad5.ok).toBe(false);
    expect(bad5.errors.join(';')).toMatch(/超出允许范围/);
  });

  /* ---------------------------------------------------------------
   * R2 期 1（2026-10-14）：`meta.nodeOffsets` —— 节点/子树级手工位置。
   * 判据口径与上一条（themeOffsets）**逐项对齐**，因为契约说两者"形状与上下界相同、只差键域"：
   * 所以这里就按**同一组输入**跑一遍，并逐条断言报文里的键路径换成了 nodeOffsets。
   * ⚠️ 上下界**不写死**（从 `OFFSET_LIMIT` 取）—— 写死的那个数会与实现漂移，
   * 而它正是"越界的界"（本工程修过"表里守的是抄本"那一族）。
   * --------------------------------------------------------------- */
  it('meta.nodeOffsets 节点/子树偏移校验：与 themeOffsets 同一套形状与上下界（只有一个键域不同）', () => {
    // 合法：更深的节点 b 偏移 (120,-40)；形状由 schema 判，**"b 是不是更深的节点"由渲染层的写回单源判**
    const ok = validateProject({ meta: { name: 'x', nodeOffsets: { b: { x: 120, y: -40 } } }, format: 'node_tree',
      data: { id: 'root', topic: 'R', children: [{ id: 'a', topic: 'A', children: [{ id: 'b', topic: 'B' }] }] } }, null);
    expect(ok.ok).toBe(true);
    // 缺省（老文件）必须照样通过 —— 可选字段、formatVersion 不升、零迁移
    const none = validateProject({ meta: { name: 'x' }, format: 'node_tree', data: { id: 'root', topic: 'R' } }, null);
    expect(none.ok).toBe(true);

    const bad1 = validateProject({ meta: { name: 'x', nodeOffsets: [1] }, format: 'node_tree', data: { id: 'root', topic: 'R' } }, null);
    expect(bad1.ok).toBe(false);
    expect(bad1.errors.join(';')).toMatch(/meta\.nodeOffsets 必须是对象/);

    const bad2 = validateProject({ meta: { name: 'x', nodeOffsets: { 'Bad ID': { x: 1, y: 1 } } }, format: 'node_tree', data: { id: 'root', topic: 'R' } }, null);
    expect(bad2.ok).toBe(false);
    expect(bad2.errors.join(';')).toMatch(/meta\.nodeOffsets 含非法 id/);

    const bad3 = validateProject({ meta: { name: 'x', nodeOffsets: { b: 5 } }, format: 'node_tree', data: { id: 'root', topic: 'R' } }, null);
    expect(bad3.ok).toBe(false);
    expect(bad3.errors.join(';')).toMatch(/meta\.nodeOffsets\.b 必须是 \{x,y\} 对象/);

    const bad4 = validateProject({ meta: { name: 'x', nodeOffsets: { b: { x: '1', y: 0 } } }, format: 'node_tree', data: { id: 'root', topic: 'R' } }, null);
    expect(bad4.ok).toBe(false);
    expect(bad4.errors.join(';')).toMatch(/meta\.nodeOffsets\.b\.x 必须是有限数字/);

    // 越界护栏（**边界从 OFFSET_LIMIT 现算**：界内过、界外拒 —— 两条一起才说明判据有分辨力）
    const inBound = validateProject({ meta: { name: 'x', nodeOffsets: { b: { x: OFFSET_LIMIT, y: -OFFSET_LIMIT } } }, format: 'node_tree', data: { id: 'root', topic: 'R' } }, null);
    expect(inBound.ok).toBe(true);
    const bad5 = validateProject({ meta: { name: 'x', nodeOffsets: { b: { x: OFFSET_LIMIT + 1, y: 0 } } }, format: 'node_tree', data: { id: 'root', topic: 'R' } }, null);
    expect(bad5.ok).toBe(false);
    expect(bad5.errors.join(';')).toMatch(/超出允许范围/);

    // 两个键的**形状判据是同一处实现**（取值表声明了两个键名 ⇒ 一个循环把两键都跑一遍）。
    // 判别力：把任一键的形状校验删掉 ⇒ 上面这组里对应的那几条必红。
    expect(OFFSET_KEYS).toEqual(['themeOffsets', 'nodeOffsets']);
    OFFSET_KEYS.forEach((k) => {
      const errs = [];
      validateOffsetMap({ n: { x: 1, y: 2 } }, 'meta.' + k, (m) => errs.push(m));
      expect(errs, k + '：合法输入不该报错').toEqual([]);
      const errs2 = [];
      validateOffsetMap({ n: { x: 1, y: 2, z: 3 } }, 'meta.' + k, (m) => errs2.push(m));
      expect(errs2, k + '：多余分量不是形状错误（只认 x/y）').toEqual([]);
      const errs3 = [];
      validateOffsetMap(null, 'meta.' + k, (m) => errs3.push(m));
      expect(errs3.join(';')).toBe('meta.' + k + ' 必须是对象');
    });
  });

  it('migrateNodeOffsets：只补缺键（空对象）、纯函数、幂等；**它不是默认路径**（默认档一个键都不写）', () => {
    // 缺键 ⇒ 补空对象；**入参一个字节都不动**（纯函数）
    const p = { meta: { name: 'x' }, format: 'node_tree', data: { id: 'root', topic: 'R' } };
    const before = JSON.stringify(p);
    const m = migrateNodeOffsets(p);
    expect(m.changed).toBe(true);
    expect(m.data.meta.nodeOffsets).toEqual({});
    expect(JSON.stringify(p)).toBe(before);
    // 幂等：再迁一次一个字节都不动（连对象都不重建）
    const again = migrateNodeOffsets(m.data);
    expect(again.changed).toBe(false);
    expect(again.data).toBe(m.data);
    // 已有键（哪怕形状坏）⇒ **不替它收拾**（交给 validate 判红）
    const p2 = { meta: { name: 'x', nodeOffsets: null } };
    const m2 = migrateNodeOffsets(p2);
    expect(m2.changed).toBe(false);
    expect(m2.data).toBe(p2);
    expect(validateProject(p2, null).ok).toBe(false);
    // 缺 meta ⇒ 不编一个出来
    const m3 = migrateNodeOffsets({ format: 'node_tree' });
    expect(m3.changed).toBe(false);
    // 迁移出来的那份**照样过校验**（补空对象不会把数据改坏）
    expect(validateProject(m.data, null).ok).toBe(true);
  });

  it('回归：返回的 errors 不再被后续调用改写（曾共用模块级数组）', () => {
    // 缺陷：errors 是模块级共享数组，调用时清空复用 →
    // 先前返回的结果对象被后续调用污染，出现 ok:true 却带错误的矛盾状态。
    const v1 = validateProject(wrap({ id: 'root', topic: 'R' }), null);
    expect(v1.ok).toBe(true);
    expect(v1.errors).toEqual([]);
    const v2 = validateProject(wrap({ id: 'Bad ID', topic: 'R' }), null);
    expect(v2.ok).toBe(false);
    // 关键：v1 必须不受影响
    expect(v1.ok).toBe(true);
    expect(v1.errors).toEqual([]);
    expect(v1.errors).not.toBe(v2.errors);
  });

  it('回归：重复 id 只报一次（曾按祖先层数重复报）', () => {
    const v = validateProject(wrap({ id: 'root', topic: 'R', children: [
      { id: 'a', topic: 'A', children: [
        { id: 'b', topic: 'B', children: [
          { id: 'x', topic: 'X1' }, { id: 'x', topic: 'X2' }
        ] }
      ] }
    ] }), null);
    const dupReports = v.errors.filter((e) => /重复 id/.test(e));
    expect(dupReports).toHaveLength(1);
  });

  it('多层嵌套的合法树不产生重复报错', () => {
    const v = validateProject(wrap({ id: 'root', topic: 'R', children: [
      { id: 'a', topic: 'A', children: [{ id: 'b', topic: 'B', children: [{ id: 'c', topic: 'C' }] }] }
    ] }), null);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });
});

/* ============================================================
 * selfProject：同项目的链接/关联成员必须以**待写入的这份数据**为准
 * ------------------------------------------------------------
 * 这两个 bug 都是"闸门读磁盘"造成的，且都已实测复现：
 *   1) 删掉被关联引用的节点能写进去（闸门看磁盘，那时节点还在），此后该项目
 *      **所有**写命令都被这条悬挂成员挡住 → 项目被锁死。
 *   2) 删除项目后导入它自己的备份，会因为备份里指向本项目的链接被判"项目不存在"
 *      而拒绝导入 → 备份无法恢复。
 * ============================================================ */
describe('schema.validateProject(..., selfProject)', () => {
  /* ------------------------------------------------------------
   * G-15 下沉（2026-10-20）：本组原来用 `mkdtempSync('mm-schema-')` 造一棵**假项目树**，
   * 再让 `validateProject` 去读盘 —— 而这一组要判的东西**与磁盘无关**，只是
   * "给了 selfProject 时要看待写数据、没给时才看别的项目"。⇒ 改成直接调纯核心
   * `validateCrossRefs(data, readProject, selfProject)`，`readProject` 查一张内存表。
   *
   * ⚠️ **断言一条没放宽**：同一批 `payload`、同一批 `expect`、连 `toMatch` 的正则都还是原文；
   *    变的只有"别的项目长什么样"由谁来回答（文件系统 → 一个函数）。
   *    磁盘那一段仍然被测到 —— 见本文件末的「注入点默认实现」一组（`makeProjectReader`）。
   * ------------------------------------------------------------ */
  /** 内存里的"别的项目"：`{ 项目名: 项目 JSON }`；没有的键 = 项目不存在 */
  const readerOf = (projects) => (proj) => (Object.prototype.hasOwnProperty.call(projects || {}, proj)
    ? { ok: true, data: projects[proj] }
    : { ok: false, reason: 'no-project' });

  const projectOf = (name, tree) => ({ meta: { name: name }, format: 'node_tree', data: tree });

  const treeP = { id: 'root', topic: 'R', children: [{ id: 'a', topic: 'A' }, { id: 'b', topic: 'B' }] };
  const payloadDroppedB = {
    meta: { name: 'P' }, format: 'node_tree',
    data: { id: 'root', topic: 'R', children: [{ id: 'a', topic: 'A' }] },
    assoc: [{ id: 'a-1', members: [{ project: 'P', id: 'a' }, { project: 'P', id: 'b' }] }]
  };

  it('不给 selfProject 时会漏判（磁盘上节点还在 → 放行）——这是被修掉的行为', () => {
    const readProject = readerOf({ P: projectOf('P', treeP) });
    expect(validateCrossRefs(payloadDroppedB, readProject, undefined).ok).toBe(true);
  });

  it('给了 selfProject：同项目成员按待写数据判 → 抓到悬挂（项目不再被锁死）', () => {
    const readProject = readerOf({ P: projectOf('P', treeP) });
    const v = validateCrossRefs(payloadDroppedB, readProject, 'P');
    expect(v.ok).toBe(false);
    expect(v.errors.join(';')).toMatch(/悬挂关联成员: P\/b 不存在/);
  });

  it('恢复备份：项目在磁盘上根本不存在，同项目链接仍应通过', () => {
    // "磁盘上一个项目都没有" ⇒ 空表（拆分前这里是"空 root 目录"）
    const readProject = readerOf({});
    const pack = {
      meta: { name: 'P' }, format: 'node_tree',
      data: { id: 'root', topic: 'R', children: [
        { id: 'a', topic: 'A', links: [{ project: 'P', id: 'b', caption: '甲到乙' }] }, { id: 'b', topic: 'B' }
      ] },
      assoc: [{ id: 'a-1', members: [{ project: 'P', id: 'a' }, { project: 'P', id: 'b' }] }]
    };
    // 没有 selfProject → 把整份备份判成悬挂链接（备份无法恢复）
    expect(validateCrossRefs(pack, readProject, undefined).ok).toBe(false);
    // 有 selfProject → 以这份数据为准，正常恢复
    expect(validateCrossRefs(pack, readProject, 'P').ok).toBe(true);
  });

  it('跨项目成员仍按磁盘判（selfProject 不放宽别的项目）', () => {
    const readProject = readerOf({
      Q: projectOf('Q', { id: 'root', topic: 'Q', children: [{ id: 'y', topic: 'Y' }] }),
      P: projectOf('P', treeP)
    });
    const okPack = {
      meta: { name: 'P' }, format: 'node_tree',
      data: { id: 'root', topic: 'R', children: [{ id: 'a', topic: 'A' }] },
      assoc: [{ id: 'a-1', members: [{ project: 'P', id: 'a' }, { project: 'Q', id: 'y' }] }]
    };
    expect(validateCrossRefs(okPack, readProject, 'P').ok).toBe(true);
    const badPack = JSON.parse(JSON.stringify(okPack));
    badPack.assoc[0].members[1].id = 'ghost';
    const v = validateCrossRefs(badPack, readProject, 'P');
    expect(v.ok).toBe(false);
    expect(v.errors.join(';')).toMatch(/悬挂关联成员: Q\/ghost 不存在/);
  });

  it('同项目里真实存在的成员不会被误判（payload 有就不再读盘）', () => {
    /* 这一条**要证明的正是"没去问 readProject"** ⇒ 故意给它一个"问到就炸"的实现：
     * 拆分前它的等价物是"磁盘里有 P，但 payload 里也有 b"。 */
    const readProject = () => { throw new Error('同项目成员不该读盘'); };
    const pack = {
      meta: { name: 'P' }, format: 'node_tree',
      data: { id: 'root', topic: 'R', children: [{ id: 'a', topic: 'A' }, { id: 'b', topic: 'B' }] },
      assoc: [{ id: 'a-1', members: [{ project: 'P', id: 'a' }, { project: 'P', id: 'b' }] }]
    };
    expect(validateCrossRefs(pack, readProject, 'P').ok).toBe(true);
  });
});

/* ------------------------------------------------------------
 * 条目级悬挂：**节点还在、条目已被删**（契约 §9 的 G2 ④ / `docs/ITEM-MODEL.md` §7）
 *
 * 为什么必须有这一档（缺口是实测出来的，不是推测）：`nodeExists` 只回 'yes'/'no'，
 * 拿不到目标节点里的 `items` ⇒ `links[].item` 指的那一条被删掉后**目标节点还在**，
 * 于是 G2 判不出来（补丁前实测：真悬挂、`validate` 仍 exit 0）。补丁给 `src/schema.js`
 * 加了 `targetNodeOf`（把节点对象带出来）+ 一档判断 —— 判据**仍只有** `src/relations.js`
 * 的 `targetHasItem` 那一份（本文件与 schema.js 都不另写第二处"条目在不在"）。
 *
 * 本组钉住两侧：**判红并点名 `项目/节点#条目`** 与 **零误报**（指向存在的那条 ⇒ 0 错）。
 * 与 `tests/link-item.test.js` 的 F2 是同一件事的两端：那边走 CLI（退出码），
 * 这边直接问 `validateProject`（报文逐字）。
 * ------------------------------------------------------------ */
describe('schema · 条目级悬挂（节点还在、条目已被删）', () => {
  /* G-15 下沉（2026-10-20）：与上一组同款 —— 这一组判的也全是**内存里的两份数据**，
   * 原来靠 `mkdtempSync('mm-schema-item-')` 造盘 + `writeProj` 落一份 JSON，纯属被签名连累。
   * 现在直接调 `validateCrossRefs(data, readProject, selfProject)`；断言原文未改。
   * ⚠️ 目标节点 b 就住在 `data` 里 ⇒ 同项目那条分支**根本不问 readProject** ——
   *    所以下面给的是"问到就炸"的实现：它同时钉住"同项目不许读盘"这条口径。 */
  const noDiskReader = () => { throw new Error('同项目引用不该读盘'); };
  /** 内存里的"别的项目"（跨项目那一档用） */
  const readerOf = (projects) => (proj) => (Object.prototype.hasOwnProperty.call(projects || {}, proj)
    ? { ok: true, data: projects[proj] }
    : { ok: false, reason: 'no-project' });

  // 目标节点的条目层：一条**真条目** + 与 `renderDetail()` **逐字节一致**的 `detail`
  // （detail 是派生缓存，必须问唯一渲染实现要 —— 契约 §5.1 明令不许复制那段逻辑）
  const ITEMS = [{ id: 'i-alive', type: 'text', html: '<p>还在的那一条</p>' }];
  const nodeB = () => ({
    id: 'b', topic: 'B',
    items: ITEMS.map((x) => Object.assign({}, x)),
    detail: String(renderDetail(ITEMS))
  });
  /** 源节点 a 上那条边：`item` 由参数给（'i-alive' = 好边，别的 = 真悬挂） */
  const packWith = (item) => ({
    meta: { name: 'P' }, format: 'node_tree',
    data: { id: 'root', topic: 'R', children: [
      { id: 'a', topic: 'A', links: [{ project: 'P', id: 'b', item: item }] },
      nodeB()
    ] }
  });

  it('条目级引用指向**存在**的条目 ⇒ 零误报（0 错）', () => {
    const v = validateCrossRefs(packWith('i-alive'), noDiskReader, 'P');
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('节点还在、条目已被删 ⇒ 判红，且**点名到 `项目/节点#条目`**（不许只写节点 id）', () => {
    const v = validateCrossRefs(packWith('i-gone'), noDiskReader, 'P');
    expect(v.ok).toBe(false);
    const msgs = v.errors.join(';');
    expect(msgs).toMatch(/悬挂链接: P\/b#i-gone 不存在/);   // 点名到条目（不是只到节点 b）
    expect(msgs).toMatch(/节点还在、条目已被删/);            // 与"节点整个不在"分开报（修法不同）
    expect(msgs).toMatch(/links-prune/);                    // 判红必须给修法（契约 §9）
    expect(msgs).toMatch(/i-alive/);                        // 并把该节点现有条目一起给出来
  });

  it('节点整个不在 ⇒ 报**节点级**那一条，条目档不重复报（同一处坏数据不许报两遍）', () => {
    const pack = packWith('i-gone');
    pack.data.children[0].links[0].id = 'nope';
    const v = validateCrossRefs(pack, noDiskReader, 'P');
    expect(v.ok).toBe(false);
    expect(v.errors).toHaveLength(1);                       // 有且只有节点级那一条
    expect(v.errors[0]).toMatch(/悬挂链接: P\/nope 不存在/);
  });

  /* 关联成员那一侧的同款（G-15 补：注入证明发现**这一档原先一条断言都没有** ——
   * 把 `itemDangling(m, at)` 那一行整行删掉，全套用例仍然全绿。现补上。） */
  it('关联成员（assoc.members）上的条目级悬挂同款判红 —— 不是只有 links 才判', () => {
    const pack = {
      meta: { name: 'P' }, format: 'node_tree',
      data: { id: 'root', topic: 'R', children: [nodeB()] },
      assoc: [{ id: 'a-1', members: [{ project: 'P', id: 'b', item: 'i-gone' },
        { project: 'P', id: 'root' }] }]
    };
    const v = validateCrossRefs(pack, noDiskReader, 'P');
    expect(v.ok).toBe(false);
    const msgs = v.errors.join(';');
    expect(msgs).toMatch(/悬挂链接: P\/b#i-gone 不存在/);
    expect(msgs).toMatch(/节点还在、条目已被删/);
    // 零误报的那一半：指向存在的条目 ⇒ 这一档不报
    pack.assoc[0].members[0].item = 'i-alive';
    expect(validateCrossRefs(pack, noDiskReader, 'P').errors.join(';')).not.toMatch(/条目已被删/);
  });

  it('跨项目（读盘那一档）同款：目标在盘上、条目已被删 ⇒ 判红；换回存在的那条 ⇒ 复绿', () => {
    const readProject = readerOf({
      Q: { meta: { name: 'Q' }, format: 'node_tree',
        data: { id: 'root', topic: 'Q', children: [nodeB()] } }
    });
    const pack = {
      meta: { name: 'P' }, format: 'node_tree',
      data: { id: 'root', topic: 'R', children: [
        { id: 'a', topic: 'A', links: [{ project: 'Q', id: 'b', item: 'i-gone' }] }
      ] }
    };
    const bad = validateCrossRefs(pack, readProject, 'P');
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(';')).toMatch(/悬挂链接: Q\/b#i-gone 不存在/);
    pack.data.children[0].links[0].item = 'i-alive';        // 撤销半步（注入证明）
    expect(validateCrossRefs(pack, readProject, 'P').errors).toEqual([]);
  });
});

/* ------------------------------------------------------------
 * localPath（本机文件夹绝对路径，见 docs/DATA-FORMAT.md §2.1）
 *
 * 这是本格式里**唯一允许的绝对路径**（资源引用仍只准相对路径），而它的校验口径是
 * **只校验形状、不校验存在性** —— 因为存在性依赖运行环境（盘没挂 / 目录还没建）。
 * 这组断言就是钉住这条边界的：谁要是"顺手"加上 existsSync 校验，换台机器就会连 validate 都红。
 * ------------------------------------------------------------ */
describe('schema · localPath（本机文件夹路径）', () => {
  const withLP = (lp) => wrap({ id: 'root', topic: 'R', children: [
    Object.assign({ id: 'a', topic: 'A' }, lp === undefined ? {} : { localPath: lp })
  ] });

  it('合法的本机路径通过（带盘符 / UNC 都行）', () => {
    expect(validateProject(withLP('E:\\markdown\\M1'), null).ok).toBe(true);
    expect(validateProject(withLP('\\\\server\\share\\dir'), null).ok).toBe(true);
  });

  it('**不校验存在性**：路径不存在也合法（盘没挂 / 目录还没建都正常）', () => {
    expect(validateProject(withLP('Z:\\绝不存在-' + Date.now()), null).ok).toBe(true);
  });

  it('空串 / 非字符串 / 含换行 / 过长 → 判红', () => {
    expect(validateProject(withLP('   '), null).ok).toBe(false);
    expect(validateProject(withLP(123), null).ok).toBe(false);
    expect(validateProject(withLP('E:\\a\nb'), null).ok).toBe(false);
    expect(validateProject(withLP('E:\\' + 'x'.repeat(600)), null).ok).toBe(false);
  });

  it('它是**可选**字段：没有它一切照旧（旧文件不需要迁移，formatVersion 仍为 2）', () => {
    const v = validateProject(withLP(undefined), null);
    expect(v.ok).toBe(true);
  });
});

/* ------------------------------------------------------------
 * origin（来源指纹，见 docs/DATA-FORMAT.md §2.8）
 *
 * 它是**批量导入幂等**的前提（节点 id 由时间+随机生成 ⇒ 同一份文档导两次会是两棵不相交的树，
 * 只能靠 src+sha256 认出来）。校验口径与 localPath 同理：**只校验形状，不重算哈希** ——
 * 重算要把源文档读回来，而它可能早已不在本机/已被改过，那会把"数据问题"变成"环境问题"。
 * 这组断言同时钉住**向后兼容**：没有 origin 的旧数据读、写、校验一切照旧。
 * ------------------------------------------------------------ */
describe('schema · origin（来源指纹）', () => {
  const SHA = 'a'.repeat(64);
  const withOrigin = (o) => wrap({ id: 'root', topic: 'R', children: [
    { id: 'a', topic: 'A', origin: o }
  ] });
  const good = { kind: 'import', src: 'docs/a.md', sha256: SHA, at: '2026-10-10T00:00:00.000Z', tool: 'import-md' };

  it('合法 origin 通过（tool 可缺省）', () => {
    expect(validateProject(withOrigin(good), null).ok).toBe(true);
    const noTool = { kind: 'import', src: 'docs/a.md', sha256: SHA, at: 'T' };
    expect(validateProject(withOrigin(noTool), null).ok).toBe(true);
    // src 可以是 URL（将来从网页导入也用同一个字段）
    expect(validateProject(withOrigin(Object.assign({}, good, { src: 'https://x/y.md' })), null).ok).toBe(true);
  });

  it('它是**可选**字段：旧数据（无 origin）照旧通过 —— 不升 formatVersion、不需要迁移', () => {
    const v = validateProject(wrap({ id: 'root', topic: 'R', children: [{ id: 'a', topic: 'A' }] }), null);
    expect(v.ok).toBe(true);
    const pack = withOrigin(undefined);
    expect(validateProject(pack, null).ok).toBe(true);
    expect(pack.meta.formatVersion === undefined || pack.meta.formatVersion === 2).toBe(true);
  });

  it('形状错的 origin 一律判红（而且理由**指名**是 origin 的哪一项）', () => {
    const cases = [
      [null, /origin 必须是对象/],
      [[], /origin 必须是对象/],
      ['x', /origin 必须是对象/],
      [Object.assign({}, good, { kind: 'copy' }), /origin\.kind/],
      [Object.assign({}, good, { src: '' }), /origin\.src/],
      [Object.assign({}, good, { src: 123 }), /origin\.src/],
      [Object.assign({}, good, { sha256: 'short' }), /origin\.sha256/],           // 截断的指纹
      [Object.assign({}, good, { sha256: SHA.toUpperCase() }), /origin\.sha256/], // 大写：形状不对
      [Object.assign({}, good, { at: '' }), /origin\.at/],
      [Object.assign({}, good, { tool: 7 }), /origin\.tool/]
    ];
    cases.forEach(([o, re]) => {
      const v = validateProject(withOrigin(o), null);
      expect(v.ok, JSON.stringify(o)).toBe(false);
      expect(v.errors.join(';')).toMatch(re);
    });
  });

  it('只校验形状：src 指向的文件**不存在**也合法（同 localPath 的理由，别把它变成环境检查）', () => {
    expect(validateProject(withOrigin(Object.assign({}, good, { src: 'Z:/绝不存在.md' })), null).ok).toBe(true);
  });
});

/* ============================================================
 * G-15 下沉（2026-10-20）：`validateProject` 拆出的两个**纯核心**
 * ------------------------------------------------------------
 * 这一组全是**新加的断言**（拆分前它们只能靠"造一棵假项目树"来测）：
 *   · `validateInPlace(data)`  —— 上半截（字段/节点/条目/环路/offset/绑定/assoc 结构）
 *   · `validateCrossRefs(data, readProject, selfProject, opts)` —— 下半截（跨项目引用）
 *   · `makeProjectReader(projectsRoot)` —— 下半截读盘**注入点的默认实现**
 * 前两个是纯的（`%TEMP%` 一个字节都不碰）；第三个**故意仍走真盘**，
 * 因为"注入点接得对不对"只能对着真实目录结构验 —— 它是本文件里**唯一**留下的一处夹具。
 * ============================================================ */
describe('schema.validateInPlace（纯核心一：喂对象就够，不读盘）', () => {
  it('合法数据 ⇒ 0 错；它**不**做跨项目判断（projectsRoot 根本不在签名里）', () => {
    const v = validateInPlace(wrap({ id: 'root', topic: 'R', children: [{ id: 'a', topic: 'A' }] }));
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(validateInPlace.length).toBe(1);          // 只有一个入参 ⇒ 想读盘也没门路
  });

  it('顶层不是对象 ⇒ 早退报"顶层必须是对象"（与 validateProject 同一句话）', () => {
    [null, undefined, 'x', 42].forEach((bad) => {
      const v = validateInPlace(bad);
      expect(v.ok, String(bad)).toBe(false);
      expect(v.errors).toEqual(['顶层必须是对象']);
    });
  });

  it('缺 meta / meta.name 空 ⇒ 判红（这些判据原先要造项目树才测得到）', () => {
    expect(validateInPlace({ format: 'node_tree', data: { id: 'root', topic: 'R' } }).errors)
      .toContain('缺少 meta');
    expect(validateInPlace({ meta: { name: '  ' }, format: 'node_tree', data: { id: 'root', topic: 'R' } }).errors)
      .toContain('meta.name 必填');
  });

  it('format 不是 node_tree / 缺 data ⇒ 判红', () => {
    const v = validateInPlace({ meta: { name: 'x' }, format: 'tree' });
    expect(v.ok).toBe(false);
    expect(v.errors.join(';')).toMatch(/format 必须为 "node_tree"/);
    expect(v.errors.join(';')).toMatch(/缺少 data（根节点）/);
  });

  it('同一次调用内的多条错误都逐条报出来（顺序 = 判定顺序）', () => {
    const v = validateInPlace({
      meta: { name: '' }, format: 'x',
      data: { id: 'Bad ID', topic: '  ' }
    });
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThanOrEqual(4);
    expect(v.errors[0]).toBe('meta.name 必填');
    expect(v.errors.join(';')).toMatch(/\[Bad ID\] 缺少 topic/);
  });

  it('**每次调用用自己的数组**：先前的返回结果不被后续调用改写（历史缺陷的回归断言）', () => {
    const good = validateInPlace(wrap({ id: 'root', topic: 'R' }));
    const bad = validateInPlace(wrap({ id: 'Bad ID', topic: 'R' }));
    expect(good.ok).toBe(true);
    expect(good.errors).toEqual([]);                 // 仍是空 —— 没被 bad 那次污染
    expect(bad.ok).toBe(false);
  });

  it('环检测仍然先于递归：含环的树报"树存在环"，不栈溢出', () => {
    const a = { id: 'a', topic: 'A' };
    const b = { id: 'b', topic: 'B', children: [a] };
    a.children = [b];
    const v = validateInPlace(wrap(a));
    expect(v.ok).toBe(false);
    expect(v.errors.join(';')).toMatch(/树存在环/);
  });

  it('条目 id 全项目唯一性仍在（跨两个节点撞号 ⇒ 判红）', () => {
    const ITEM = [{ id: 'dup', type: 'text', html: '<p>x</p>' }];
    const node = (id) => ({ id: id, topic: id, items: ITEM.map((x) => Object.assign({}, x)),
      detail: String(renderDetail(ITEM)) });
    const v = validateInPlace(wrap({ id: 'root', topic: 'R', children: [node('a'), node('b')] }));
    expect(v.ok).toBe(false);
    expect(v.errors.join(';')).toMatch(/重复条目 id: dup/);
  });

  it('工作区绑定（bindings）形状校验也在这半截里：deletions 只准 propose-only', () => {
    const pack = wrap({ id: 'root', topic: 'R' });
    pack.bindings = [{ id: 'wb-1', dir: 'D:\\a', mode: 'flat', deletions: 'auto' }];
    const v = validateInPlace(pack);
    expect(v.ok).toBe(false);
    expect(v.errors.join(';')).toMatch(/deletions 只能是 "propose-only"/);
    pack.bindings[0].deletions = 'propose-only';
    expect(validateInPlace(pack).ok).toBe(true);
  });
});

describe('schema.validateCrossRefs（纯核心二：readProject 注入 ⇒ 不造盘）', () => {
  const readerOf = (projects) => (proj) => (Object.prototype.hasOwnProperty.call(projects || {}, proj)
    ? { ok: true, data: projects[proj] }
    : { ok: false, reason: 'no-project' });
  const linkPack = (project, id) => ({
    meta: { name: 'P' }, format: 'node_tree',
    data: { id: 'root', topic: 'R', children: [{ id: 'a', topic: 'A', links: [{ project: project, id: id }] }] }
  });

  it('目标项目在"盘上"且节点在 ⇒ 0 错', () => {
    const readProject = readerOf({ Q: { meta: { name: 'Q' }, data: { id: 'root', topic: 'Q' } } });
    const v = validateCrossRefs(linkPack('Q', 'root'), readProject, 'P');
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('目标项目不存在 ⇒ "悬挂链接: 项目不存在 <名>"', () => {
    const v = validateCrossRefs(linkPack('Q', 'root'), readerOf({}), 'P');
    expect(v.ok).toBe(false);
    expect(v.errors.join(';')).toMatch(/悬挂链接: 项目不存在 Q/);
  });

  it('项目在、节点不在 ⇒ "悬挂链接: <项目>/<id> 不存在"', () => {
    const readProject = readerOf({ Q: { meta: { name: 'Q' }, data: { id: 'root', topic: 'Q' } } });
    const v = validateCrossRefs(linkPack('Q', 'ghost'), readProject, 'P');
    expect(v.errors.join(';')).toMatch(/悬挂链接: Q\/ghost 不存在/);
  });

  it('项目读不出来 ⇒ "悬挂链接: 无法读取 <名>（原因）"（三档之一，报文不许合并）', () => {
    const readProject = () => ({ ok: false, reason: 'unreadable', detail: 'Unexpected token }' });
    const v = validateCrossRefs(linkPack('Q', 'root'), readProject, 'P');
    expect(v.ok).toBe(false);
    expect(v.errors.join(';')).toMatch(/悬挂链接: 无法读取 Q（Unexpected token \}）/);
  });

  it('links[i] 不是对象 / 缺 project-id ⇒ 在本半截里判红（拆出来之后仍然报）', () => {
    const pack = wrap({ id: 'root', topic: 'R', children: [
      { id: 'a', topic: 'A', links: ['x', { id: 'no-proj' }] }
    ] });
    const v = validateCrossRefs(pack, readerOf({}), 'P');
    expect(v.ok).toBe(false);
    expect(v.errors.join(';')).toMatch(/links\[0\] 不是对象/);
    expect(v.errors.join(';')).toMatch(/links\[1\] 缺少 project\/id/);
  });

  it('注入点没给 ⇒ **响亮抛错**（不许静默跳过整档跨项目判据）', () => {
    expect(() => validateCrossRefs(linkPack('Q', 'root'), null, 'P')).toThrow(/readProject/);
    expect(() => validateCrossRefs(linkPack('Q', 'root'), undefined, 'P')).toThrow(/readProject/);
  });

  it('锚点档：默认不判（opts.checkAnchors 缺省）；给了 true 才判 —— 口径与拆分前一致', () => {
    const pack = {
      meta: { name: 'P' }, format: 'node_tree',
      data: { id: 'root', topic: 'R', children: [{ id: 'a', topic: 'A' }] },
      assoc: [{ id: 'a-1', members: [{ project: 'P', id: 'a' }, { project: 'P', id: 'root' }],
        anchors: [{ project: 'P', id: 'nope', kind: 'heading', text: '绝不存在的一句话', label: '那句话' }] }]
    };
    expect(validateCrossRefs(pack, readerOf({}), 'P').ok).toBe(true);                       // 默认档
    const v = validateCrossRefs(pack, readerOf({}), 'P', { checkAnchors: true });
    expect(v.ok).toBe(false);
    expect(v.errors.join(';')).toMatch(/失效锚点/);
  });
});

describe('schema.makeProjectReader（下半截读盘注入点的默认实现）', () => {
  /* 这一组是"注入点接到哪"的证明 ⇒ 必须对着**真实目录结构**验（用假 fs 验等于把被测物换掉）。
   * G-15 之后只剩 **1 个**注册式临时目录（专给"文件在但不是合法 JSON"那一档 —— 它需要造一个坏文件）；
   * 其余两档直接用仓库里**真实存在**的 `projects/`（只读，一个字节都不写）。 */
  const TMP = makeTmp('mm-schema-reader-');

  it('按 `<root>/<项目>/<项目>.json` 找：真项目 ⇒ {ok:true,data}；不存在的项目 ⇒ {ok:false,reason:"no-project"}', () => {
    // 用真实项目根（只读）：这条同时钉住"生产路径指的是 projects/<名>/<名>.json"
    const readProject = makeProjectReader(REAL_PROJECTS);
    const r = readProject('comnet');
    expect(r.ok).toBe(true);
    expect(r.data && r.data.data && typeof r.data.data.id).toBe('string');   // 真读到了根节点
    expect(readProject('no-such-project-g15-xyz')).toEqual({ ok: false, reason: 'no-project' });
  });

  it('文件在但**不是合法 JSON** ⇒ {ok:false,reason:"unreadable",detail}（不是"不存在"）', () => {
    fs.mkdirSync(path.join(TMP, 'Bad'), { recursive: true });
    fs.writeFileSync(path.join(TMP, 'Bad', 'Bad.json'), '{ 这不是 JSON', 'utf8');
    const r = makeProjectReader(TMP)('Bad');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unreadable');
    expect(typeof r.detail).toBe('string');
    expect(r.detail.length).toBeGreaterThan(0);
  });

  it('与 `validateProject` 接起来时行为不变：真盘上的悬挂链接仍判红、修好即复绿', () => {
    const root = TMP;
    fs.mkdirSync(path.join(root, 'Q'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Q', 'Q.json'),
      JSON.stringify({ meta: { name: 'Q' }, format: 'node_tree', data: { id: 'root', topic: 'Q' } }), 'utf8');
    const pack = linkPackOf('Q', 'ghost');
    const bad = validateProject(pack, root, 'P');
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(';')).toMatch(/悬挂链接: Q\/ghost 不存在/);
    pack.data.children[0].links[0].id = 'root';        // 撤销半步（注入证明）
    expect(validateProject(pack, root, 'P').errors).toEqual([]);
  });

  it('对**真实项目树**跑 `validateProject` 仍然通过（生产路径 + 注入点接在一起没走样）', () => {
    const name = 'comnet';
    const pack = JSON.parse(fs.readFileSync(path.join(REAL_PROJECTS, name, name + '.json'), 'utf8'));
    const v = validateProject(pack, REAL_PROJECTS, name);
    expect(v.ok, v.errors.join(';')).toBe(true);
  });

  it('`validateProject` 的跨项目档在 projectsRoot 缺省时整段跳过（浏览器侧同款）', () => {
    // 不传 projectsRoot ⇒ 不读盘 ⇒ 悬挂链接判不出来（与拆分前逐字节一致的口径）
    expect(validateProject(linkPackOf('Q', 'ghost')).ok).toBe(true);
  });

  function linkPackOf(project, id) {
    return {
      meta: { name: 'P' }, format: 'node_tree',
      data: { id: 'root', topic: 'R', children: [{ id: 'a', topic: 'A', links: [{ project: project, id: id }] }] }
    };
  }
});
