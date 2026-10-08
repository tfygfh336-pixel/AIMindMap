/* ============================================================
 * tests/schema.test.js — 数据校验单元测试（vitest）
 * 覆盖：环检测（历史栈溢出 bug）、重复 id、字段校验、正常树
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateProject } from '../src/schema.js';

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
  const mk = (name, tree) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-schema-'));
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '.json'),
      JSON.stringify({ meta: { name: name }, format: 'node_tree', data: tree }), 'utf8');
    return root;
  };
  const tmpDirs = [];
  const mkTmp = (name, tree) => { const r = mk(name, tree); tmpDirs.push(r); return r; };
  afterAll(() => { tmpDirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } }); });

  const treeP = { id: 'root', topic: 'R', children: [{ id: 'a', topic: 'A' }, { id: 'b', topic: 'B' }] };
  const payloadDroppedB = {
    meta: { name: 'P' }, format: 'node_tree',
    data: { id: 'root', topic: 'R', children: [{ id: 'a', topic: 'A' }] },
    assoc: [{ id: 'a-1', members: [{ project: 'P', id: 'a' }, { project: 'P', id: 'b' }] }]
  };

  it('不给 selfProject 时会漏判（磁盘上节点还在 → 放行）——这是被修掉的行为', () => {
    const root = mkTmp('P', treeP);
    expect(validateProject(payloadDroppedB, root).ok).toBe(true);
  });

  it('给了 selfProject：同项目成员按待写数据判 → 抓到悬挂（项目不再被锁死）', () => {
    const root = mkTmp('P', treeP);
    const v = validateProject(payloadDroppedB, root, 'P');
    expect(v.ok).toBe(false);
    expect(v.errors.join(';')).toMatch(/悬挂关联成员: P\/b 不存在/);
  });

  it('恢复备份：项目在磁盘上根本不存在，同项目链接仍应通过', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-schema-'));
    tmpDirs.push(root);
    const pack = {
      meta: { name: 'P' }, format: 'node_tree',
      data: { id: 'root', topic: 'R', children: [
        { id: 'a', topic: 'A', links: [{ project: 'P', id: 'b', caption: '甲到乙' }] }, { id: 'b', topic: 'B' }
      ] },
      assoc: [{ id: 'a-1', members: [{ project: 'P', id: 'a' }, { project: 'P', id: 'b' }] }]
    };
    // 没有 selfProject → 把整份备份判成悬挂链接（备份无法恢复）
    expect(validateProject(pack, root).ok).toBe(false);
    // 有 selfProject → 以这份数据为准，正常恢复
    expect(validateProject(pack, root, 'P').ok).toBe(true);
  });

  it('跨项目成员仍按磁盘判（selfProject 不放宽别的项目）', () => {
    const root = mkTmp('Q', { id: 'root', topic: 'Q', children: [{ id: 'y', topic: 'Y' }] });
    mkTmp('P', treeP);
    const okPack = {
      meta: { name: 'P' }, format: 'node_tree',
      data: { id: 'root', topic: 'R', children: [{ id: 'a', topic: 'A' }] },
      assoc: [{ id: 'a-1', members: [{ project: 'P', id: 'a' }, { project: 'Q', id: 'y' }] }]
    };
    expect(validateProject(okPack, root, 'P').ok).toBe(true);
    const badPack = JSON.parse(JSON.stringify(okPack));
    badPack.assoc[0].members[1].id = 'ghost';
    const v = validateProject(badPack, root, 'P');
    expect(v.ok).toBe(false);
    expect(v.errors.join(';')).toMatch(/悬挂关联成员: Q\/ghost 不存在/);
  });

  it('同项目里真实存在的成员不会被误判（payload 有就不再读盘）', () => {
    const root = mkTmp('P', treeP);
    const pack = {
      meta: { name: 'P' }, format: 'node_tree',
      data: { id: 'root', topic: 'R', children: [{ id: 'a', topic: 'A' }, { id: 'b', topic: 'B' }] },
      assoc: [{ id: 'a-1', members: [{ project: 'P', id: 'a' }, { project: 'P', id: 'b' }] }]
    };
    expect(validateProject(pack, root, 'P').ok).toBe(true);
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
