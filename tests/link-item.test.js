/* ============================================================
 * tests/link-item.test.js — 条目级链接与"节点在、条目不在"的悬挂（S6 关系/标签升层）
 * ------------------------------------------------------------
 * 契约依据：`docs/ITEM-MODEL.md` §3（`link` 的签名）、§7（`links[].item` / 标签两级）、
 *          §12（S6 那一句：「悬挂检测与节点级**同一处逻辑**」）。
 *
 * 本文件锁住的语义（每条都对应一种"看起来成功、其实做了别的事"）：
 *   ① `link --item <id>`：边指向**某节点里的某一条条目**；被指向的条目必须真的在，
 *      不在就**响亮拒绝并点名**（绝不许造出"节点在、条目不在"的悬挂引用 ——
 *      那种引用会把目标项目**所有**写命令一起锁死）；
 *   ② **沿用 K8 的三态词**（S6 不另造一套）：重放**同一三元组**（项目, 节点, 条目）⇒「无变化」；
 *      省略 `--item` = 条目为空那一档 = **节点级那条边**（与条目级边是两条边）；
 *      显式 `--item <id>` ⇒ 覆盖/新起那一条；显式 `--item ""` ⇒ 清空条目层；
 *      三种结局回显分别可见（`已添加链接`/`已更新链接`/`无变化`），
 *      并且与 K8 的 caption 三态**同一套**（这里逐条对着 `tests/link-caption.test.js` 的形状写）；
 *   ③ 条目级边的**判定键是 (项目, 节点, 条目)**：同 (源,目标) 上"节点级一条 + 条目级一条"
 *      是两条边，各自独立添加/更新/去重，**互不吞掉**；
 *   ④ 读口（`links` / `backlinks` / `related`）**只增字段**：带 item 的边多 `item`
 *      （+ `itemLabel`），节点级的边**一个字段都不多** —— 旧数据与旧消费者零改动；
 *   ⑤ **悬挂判据只有一处**：`src/relations.js` 的 `refState()` / `targetHasItem()`。
 *      本文件用"CLI 的清理出口"与"纯函数判据"**互相印证**（同一输入 ⇒ 同一结论），
 *      并把判别力注入进去：把条目级那一档关掉 ⇒ 断言必红（见 §E 的注入证明）；
 *   ⑥ `links-prune`：**节点还在、条目已被删**这一档如实报告并剪掉那条边；
 *      `--dry-run` 不写盘；剪完 `validate` 必须 exit 0（闸门复绿）。
 *   ⑦ **闸门（G2）现已判这一档**（补丁落地后）：条目级悬挂 ⇒ `validate` **非 0**，
 *      且报文点名 `项目/节点#条目`。F2 原先是"缺口探针"（守旧事实：钉住"闸门还判不出来"），
 *      补丁落地后**同批反转**为 `.not.toBe(0)` —— 守旧事实的断言不许继续替一个
 *      已经不存在的现状站岗；史料说明留在 F2 里，别删。
 *
 * ⚠️ 两个环境要点（与 `tests/link-caption.test.js` 同一口径，改这个文件前先读）：
 *   1) **绝不许碰真实 `projects/`**：`AI_MINDMAP_PROJECTS_DIR` 必须在 `require cli/main.js`
 *      **之前**设好 —— `cli/core.js` 的 `PROJECTS_DIR` 是**模块加载时**定型的。故本文件在
 *      加载时先自证重定向生效，不生效就**当场红**，绝不"先跑起来再说"。
 *   2) **不起子进程**：本工程记过"受限环境（企业 EDR/沙箱）下管道 stdio 会 EPERM 假失败"。
 *      故用进程内 `invokeSync`（与 `tests/link-caption.test.js` 同一口径）。
 * ============================================================ */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);

/* ---- ① 先在临时目录上建项目根（必须在 require cli/main.js 之前） ----
 * ⚠️ 建目录走 `tests/_tmp-cleanup.js` 的 `makeTmp`（= `mkdtempSync` + **创建即登记**）。
 *   本文件此前是**裸 `mkdtempSync` 且全文没有任何收尾**（一个 `rmSync` 都没有）⇒
 *   每跑一次就在 `%TEMP%` 里留下一个 `mm-s6-*`。实测（2026-10-19 改造前）：
 *     单跑本文件一次 ⇒ `mm-s6-*` **+1**（真零 TEMP 下也是 +1：`mm-s6-Lhr4rT`）；
 *     `%TEMP%` 里已积到 **779** 个 —— 全工程最大的一个家族（占全部 `mm-*` 的 77%）。 */
const TMP_ROOT = makeTmp('mm-s6-');
process.env.AI_MINDMAP_PROJECTS_DIR = TMP_ROOT;
const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const relations = require('../src/relations.js');

/* 重定向必须**当场**生效：否则夹具会建进真实 `projects/` —— 这是最坏的一类错误
 * （测试污染真实数据），所以宁可在这里响亮地红，也不继续往下走。 */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(TMP_ROOT)) {
  throw new Error('项目根重定向未生效（cli/core.js 已被更早加载）：PROJECTS_DIR='
    + core.PROJECTS_DIR + ' 期望=' + TMP_ROOT + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

/* 收尾**只此一处**：删掉所有登记过的临时根（含将来在这个文件里新加的那些）。
 * ⚠️ 别在用例里再补一份 `fs.rmSync(TMP_ROOT, …)` —— 那正是本文件此前留 779 个残留的形状：
 *   "清理代码看着有"却删不到"建了却没被引用"的那一个（判据见 `tests/_tmp-cleanup.js` 头注释）。 */
afterAll(cleanupAll);

/* 探针一律 `it-s6-` 前缀（§4.1 的锚点分配；与别的流的探针互不踩） */
const SRC = 'it-s6-src';
const DST = 'it-s6-dst';
const A = 'it-s6-a';        // 源节点（出边挂在它上面）
const A2 = 'it-s6-a2';      // 第二个源节点（钉"节点级与条目级并存"）
const AD = 'it-s6-ad';      // 读口段的专用源节点（夹具**直接写盘**造，见 §D 的 plantAd）
const T = 'it-s6-t';        // 目标节点（条目化）
const T_EMPTY = 'it-s6-t-empty';  // 目标节点（没有 items 键：老数据/富文本）
const CAP_A = '出自：S6 甲（AI 凭 caption 判断内容）';

const projFile = (name) => path.join(TMP_ROOT, name, name + '.json');
const readText = (name) => fs.readFileSync(projFile(name), 'utf8');
const readDisk = (name) => JSON.parse(readText(name));
/** 项目的 `data` 根 —— 纯函数判据（`refState`）的入参形状 */
const readDiskProj = (name) => readDisk(name).data;
const writeDisk = (name, d) => fs.writeFileSync(projFile(name), JSON.stringify(d, null, 2), 'utf8');
const nodeOf = (data, id) => {
  let hit = null;
  (function walk(n) {
    if (!n) return;
    if (n.id === id) { hit = n; return; }
    (n.children || []).forEach(walk);
  })(data.data);
  return hit;
};
/** 源节点上的出边（**盘上真值**，不是命令回显） */
const edgesOf = (nodeId, proj = SRC) => nodeOf(readDisk(proj), nodeId).links || [];
/** 指向目标的**那一条**边（按 项目/节点/条目 三档判定 —— 与实现的判定键同口径） */
const edgeTo = (nodeId, target, item, proj = SRC) => edgesOf(nodeId, proj).find((l) => l
  && l.project === DST && l.id === target && relations.itemKey(l.item) === relations.itemKey(item)) || null;

/** 跑一条命令（进程内、同步）：返回 { code, out }（stdout+stderr 合并，与集成脚本同口径） */
const run = (...args) => {
  const r = invokeSync(args);
  return { code: r.code, out: (r.stdout + r.stderr).trim() };
};
const json = (out) => JSON.parse(String(out).trim());
/** 从回显里取那一条条目的 id（回显必须点名 itemId —— 契约 §3 的通用约定） */
const itemIdOf = (out) => {
  const m = /(i-[a-z0-9-]+)/.exec(String(out));
  return m ? m[1] : null;
};
/** 直接在盘上造一条边（含**故意的**坏 data：这是测悬挂的唯一办法） */
const plantEdge = (nodeId, edge, proj = SRC) => {
  const d = readDisk(proj);
  nodeOf(d, nodeId).links = (nodeOf(d, nodeId).links || []).concat([edge]);
  writeDisk(proj, d);
};

let IA;   // 目标节点 T 上的条目甲（有 tags ⇒ itemLabel 取标签）
let IB;   // 目标节点 T 上的条目乙
let IP;   // 目标节点 T 上的条目丙（专给"清空条目层"那一档当探针）
beforeAll(() => {
  expect(run('init', SRC, '--title', 'S6 探针源').code).toBe(0);
  expect(run('init', DST, '--title', 'S6 探针目标').code).toBe(0);
  expect(run('add', SRC, 'root', '--topic', 'S6 源甲', '--id', A).code).toBe(0);
  expect(run('add', SRC, 'root', '--topic', 'S6 源乙', '--id', A2).code).toBe(0);
  expect(run('add', SRC, 'root', '--topic', 'S6 源丙（读口段）', '--id', AD).code).toBe(0);
  expect(run('add', DST, 'root', '--topic', 'S6 目标（条目化）', '--id', T).code).toBe(0);
  expect(run('add', DST, 'root', '--topic', 'S6 目标（无条目层）', '--id', T_EMPTY).code).toBe(0);
  const rA = run('item-add', DST, T, '--html', '<p>甲条正文</p>', '--tags', '门禁,检索');
  const rB = run('item-add', DST, T, '--html', '<p>乙条正文</p>');
  const rP = run('item-add', DST, T, '--html', '<p>丙条正文</p>');
  expect(rA.code).toBe(0);
  expect(rB.code).toBe(0);
  expect(rP.code).toBe(0);
  IA = itemIdOf(rA.out);
  IB = itemIdOf(rB.out);
  IP = itemIdOf(rP.out);
  expect(IA).toBeTruthy();
  expect(IB).toBeTruthy();
  expect(IP).toBeTruthy();
  expect(new Set([IA, IB, IP]).size).toBe(3);
});

describe('S6 沙箱前提（先自证，再断言）', () => {
  it('项目根已被重定向到临时目录 —— 这个文件绝不许写真实 projects/', () => {
    expect(path.resolve(core.PROJECTS_DIR)).toBe(path.resolve(TMP_ROOT));
    expect(fs.existsSync(projFile(SRC))).toBe(true);
    expect(fs.existsSync(projFile(DST))).toBe(true);
    // 夹具前提先证明：目标节点上真的有那三条条目（结论依赖它，就不能默认它成立）
    expect(nodeOf(readDisk(DST), T).items.map((x) => x.id)).toEqual([IA, IB, IP]);
  });
});

/* ============================================================
 * §A 写入口：`link --item`
 * ============================================================ */
describe('A · link --item：边指向"某节点里的某一条条目"', () => {
  it('A1 首次添加：回显点名 `目标/节点#条目`，落盘形状 = {project,id,item}', () => {
    const r = run('link', SRC, A, '--to', DST, '--id', T, '--item', IA);
    expect(r.code).toBe(0);
    expect(r.out).toContain('已添加链接: ' + A + ' → ' + DST + '/' + T + '#' + IA);
    expect(edgeTo(A, T, IA)).toEqual({ project: DST, id: T, item: IA });
  });

  it('A2 带 caption 与 item 同给：两个字段都以"数据"落盘（不含空串噪音键）', () => {
    const r = run('link', SRC, A, '--to', DST, '--id', T, '--item', IA, '--caption', CAP_A);
    expect(r.code).toBe(0);
    expect(r.out).toContain('已更新链接');
    expect(edgeTo(A, T, IA)).toEqual({ project: DST, id: T, item: IA, caption: CAP_A });
  });

  it('A3 ★目标节点在、条目不在 ⇒ 非 0 退出 + **点名**那个条目 + 盘上零改动（绝不造悬挂引用）', () => {
    const before = readText(SRC);
    const r = run('link', SRC, A, '--to', DST, '--id', T, '--item', 'i-does-not-exist');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('目标条目不存在');
    expect(r.out).toContain(DST + '/' + T + '#i-does-not-exist');   // 点名到 (项目/节点#条目)
    expect(r.out).toContain('--item');                             // 给出路（省略就是节点级）
    expect(readText(SRC)).toBe(before);                            // 拒绝 = 一个字节都不写
  });

  it('A4 目标节点**没有条目层**（无 items 键）⇒ 同样拒绝并说清该节点没有条目层', () => {
    const before = readText(SRC);
    const r = run('link', SRC, A, '--to', DST, '--id', T_EMPTY, '--item', IA);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('目标条目不存在');
    expect(r.out).toContain('没有条目层');
    expect(readText(SRC)).toBe(before);
  });

  it('A5 只写 `--item` 不给值 ⇒ 响亮拒绝（旧病：把 `true` 原样写进数据）且盘上零改动', () => {
    const before = readText(SRC);
    const r = run('link', SRC, A, '--to', DST, '--id', T, '--item');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('--item 需要一个条目 id');
    expect(readText(SRC)).toBe(before);
  });

  it('A6 条目级的自链接同样被拒（不能指向自己所在节点的那一条）', () => {
    const r = run('link', SRC, A, '--to', SRC, '--id', A, '--item', 'i-whatever');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('不能链接到自身');
  });
});

/* ============================================================
 * §B 三态语义：**沿用 K8 那套词**（三种结局可分辨、不产生空写入）
 * ============================================================ */
describe('B · 三态语义（S6 沿用 K8 的 `已添加链接` / `已更新链接` / `无变化`，不另造话术）', () => {
  it('B1 重放（同 --item）⇒「无变化」且盘上**逐字节不变**（不产生空写入）', () => {
    const before = readText(SRC);
    const r = run('link', SRC, A, '--to', DST, '--id', T, '--item', IA);
    expect(r.code).toBe(0);
    expect(r.out).toContain('无变化');
    expect(r.out).not.toContain('已添加链接');
    expect(r.out).toContain('item: ' + IA);          // 保留/沿用的那一层也要看得见
    expect(readText(SRC)).toBe(before);
  });

  it('B2 ★省略 --item ⇒ 命中的是**节点级**那条边（条目为空那一档）⇒ 新起它，**不吞掉**条目级那条', () => {
    // ⚠️ 改前这条断言的是"省略 `--item` ⇒ 无变化且保留 item" —— 那等于把"同一条边"当成 (源,目标)
    //    两元组，与 `--item` 的意义自相矛盾：省略 --item 是**另一条边**（条目为空那条）。
    //    实测后果：节点级那条边**永远建不出来**（cli-integration §S6 之四/之五跟着红）。
    const beforeItemEdge = JSON.stringify(edgeTo(A, T, IA));
    const r = run('link', SRC, A, '--to', DST, '--id', T, '--caption', CAP_A);
    expect(r.code).toBe(0);
    expect(r.out).toContain('已添加链接');                     // 新的一条边，不是对条目级那条的覆盖
    expect(JSON.stringify(edgeTo(A, T, IA))).toBe(beforeItemEdge);   // 条目级那条逐字节没动（item 不被抹掉）
    expect(edgeTo(A, T, '')).toEqual({ project: DST, id: T, caption: CAP_A });
    // 三态词只对**同一条边**成立：重放刚建的这条节点级的边 ⇒「无变化」且零写入
    const before = readText(SRC);
    const r2 = run('link', SRC, A, '--to', DST, '--id', T, '--caption', CAP_A);
    expect(r2.code).toBe(0);
    expect(r2.out).toContain('无变化');
    expect(readText(SRC)).toBe(before);
  });

  it('B3 显式换条目 ⇒ **新起一条条目级的边**，原有那条（含 caption/其它字段）不被重建、不重排', () => {
    const beforeRows = JSON.stringify(edgesOf(A));
    const r = run('link', SRC, A, '--to', DST, '--id', T, '--item', IB);
    expect(r.code).toBe(0);
    expect(r.out).toContain('已添加链接');                          // 换条目 = 另一条边，不是"覆盖旧的那条"
    expect(r.out).toContain(DST + '/' + T + '#' + IB);
    // 条目甲那条**逐字节没动**（这是"两条边并存"的关键：换一边不该把前一边带走）
    expect(JSON.stringify([edgeTo(A, T, IA)])).toBe(JSON.stringify(
      [JSON.parse(beforeRows).find((l) => relations.itemKey(l.item) === IA)]));
    expect(edgeTo(A, T, IB)).toEqual({ project: DST, id: T, item: IB });
    // 只追加、不重排：`IA`（B1 那条）→ ``（B2 新起的节点级那条）→ `IB`（本条）。三个位置都不是插入。
    expect(edgesOf(A).map((l) => relations.itemKey(l.item))).toEqual([IA, '', IB]);
  });

  it('B3b 把**节点级**那条升级成条目级：`--item` 命中的是那条没有条目层的边（重放仍是无变化）', () => {
    // 先造一条节点级的边（A2 上）
    expect(run('link', SRC, A2, '--to', DST, '--id', T, '--caption', '节点级注').code).toBe(0);
    const r1 = run('link', SRC, A2, '--to', DST, '--id', T, '--item', IA);
    expect(r1.code).toBe(0);
    expect(r1.out).toContain('已更新链接');
    expect(r1.out).toContain('item: （无） → ' + IA);
    expect(edgeTo(A2, T, IA)).toEqual({ project: DST, id: T, item: IA, caption: '节点级注' });  // caption 留着
    expect(edgeTo(A2, T, '')).toBeNull();                          // 那条节点级的边被**升级**，不是又加一条
    const r2 = run('link', SRC, A2, '--to', DST, '--id', T, '--item', IA);
    expect(r2.code).toBe(0);
    expect(r2.out).toContain('无变化');                             // 重放安全（同一条命令两次 ⇒ 第二次无事可做）
  });

  it('B4 ★显式 `--item ""` ⇒ 条目层被**清空**（边退回节点级），回显点明「item 清空」', () => {
    // 夹具前提：先给**没有条目层**的目标建一条节点级边，再把它升级到 T_EMPTY 自己的条目
    // （T 上的 IA/IB/IP 不属于 T_EMPTY —— 条目 id 属于**某个节点**，这正是条目层的语义）。
    const rP = run('item-add', DST, T_EMPTY, '--html', '<p>空节点上的条目</p>');
    expect(rP.code).toBe(0);
    const iP = itemIdOf(rP.out);
    expect(iP).toBeTruthy();
    expect(run('link', SRC, A, '--to', DST, '--id', T_EMPTY, '--caption', '先建节点级').code).toBe(0);
    expect(run('link', SRC, A, '--to', DST, '--id', T_EMPTY, '--item', iP).code).toBe(0);
    expect(edgeTo(A, T_EMPTY, iP).caption).toBe('先建节点级');          // 升级保留 caption

    const before = readText(SRC);
    const r = run('link', SRC, A, '--to', DST, '--id', T_EMPTY, '--item', '');
    expect(r.code).toBe(0);
    expect(r.out).toContain('已更新链接');
    expect(r.out).toContain('item 清空');
    expect(r.out).toContain(iP);                      // 清的是哪一条：点名原来的 item（"改了哪里"必须看得见）
    const e = edgeTo(A, T_EMPTY, '');
    expect(e).not.toBeNull();
    expect('item' in e).toBe(false);                  // 清空 = 不留空串键
    expect(e.caption).toBe('先建节点级');               // 清的是条目层，不是说明
    expect(readText(SRC)).not.toBe(before);
  });

  it('B5 清空后重放 ⇒「无变化」且盘上零改动（幂等）', () => {
    const before = readText(SRC);
    const r = run('link', SRC, A, '--to', DST, '--id', T_EMPTY, '--item', '');
    expect(r.code).toBe(0);
    expect(r.out).toContain('无变化');
    expect(readText(SRC)).toBe(before);
  });
});

/* ============================================================
 * §C 判定键 = (项目, 节点, **条目**)：两级边并存、各自独立
 * ============================================================ */
describe('C · 节点级与条目级是**两条边**（判定键含条目层）', () => {
  it('C1 同 (源,目标) 上：节点级一条 + 条目级两条 ⇒ 盘上三条，互不吞掉', () => {
    // 先给**条目化**的 T 两条条目级边（先到先得：节点级那条后来才建，不会被升级掉）
    expect(run('link', SRC, A2, '--to', DST, '--id', T, '--item', IA, '--caption', '甲注').code).toBe(0);
    expect(run('link', SRC, A2, '--to', DST, '--id', T, '--item', IB, '--caption', '乙注').code).toBe(0);
    // 再给**没有条目层**的 T_EMPTY 建一条节点级边 —— 三档互不吞掉
    expect(run('link', SRC, A2, '--to', DST, '--id', T_EMPTY).code).toBe(0);
    expect(edgesOf(A2).map((l) => relations.itemKey(l.item))).toEqual([IA, IB, '']);
    expect(edgesOf(A2).map((l) => l.id)).toEqual([T, T, T_EMPTY]);
  });

  it('C2 重放**节点级**那条（同目标同项目，不给 --item）⇒「无变化」且逐字节不变', () => {
    const before = JSON.stringify(edgesOf(A2));
    const r = run('link', SRC, A2, '--to', DST, '--id', T_EMPTY);
    expect(r.code).toBe(0);
    expect(r.out).toContain('无变化');
    expect(JSON.stringify(edgesOf(A2))).toBe(before);
  });

  it('C2b ★重放**条目级**那条：第二次仍是「无变化」（重放安全是硬要求，条目层不许破例）', () => {
    const before = JSON.stringify(edgesOf(A2));
    const r = run('link', SRC, A2, '--to', DST, '--id', T, '--item', IA);
    expect(r.code).toBe(0);
    expect(r.out).toContain('无变化');
    expect(JSON.stringify(edgesOf(A2))).toBe(before);
    expect(edgesOf(A2).length).toBe(3);              // 没有因为重放多出一条
  });

  it('C3 更新条目级甲 ⇒ 条目级乙与节点级那条**逐字节不变**（不重建、不重排数组）', () => {
    const others = JSON.stringify(edgesOf(A2).filter((l) => relations.itemKey(l.item) !== IA));
    const r = run('link', SRC, A2, '--to', DST, '--id', T, '--item', IA, '--caption', '甲注改');
    expect(r.code).toBe(0);
    expect(r.out).toContain('已更新链接');
    expect(edgeTo(A2, T, IA).caption).toBe('甲注改');
    expect(JSON.stringify(edgesOf(A2).filter((l) => relations.itemKey(l.item) !== IA))).toBe(others);
    expect(edgesOf(A2).map((l) => relations.itemKey(l.item))).toEqual([IA, IB, '']);   // 顺序不变
  });

  it('C4 边上的其它字段（`note`）在改 item 时不被顺手抹掉', () => {
    const d = readDisk(SRC);
    nodeOf(d, A2).links.find((l) => relations.itemKey(l.item) === IB).note = '手工附的笔记';
    writeDisk(SRC, d);
    const r = run('link', SRC, A2, '--to', DST, '--id', T, '--item', IB, '--caption', '乙注二');
    expect(r.code).toBe(0);
    expect(edgeTo(A2, T, IB).note).toBe('手工附的笔记');
    expect(edgeTo(A2, T, IB).caption).toBe('乙注二');
  });
});

/* ---- D 段专用源节点的夹具：**直接写盘**造出"三种条目层并存"的精确状态 ----
 * 为什么不用 CLI 造：CLI 的语义本身是被测对象（"升级""清空"那些分支），拿它造夹具会把
 * "夹具对不对"与"被测对不对"缠在一起；这一段要的是**确定的盘上形状**。 */
const plantAd = () => {
  const d = readDisk(SRC);
  nodeOf(d, AD).links = [
    { project: DST, id: T, item: IA, caption: '甲注' },
    { project: DST, id: T, item: IB, caption: '乙注' },
    { project: DST, id: T_EMPTY, caption: '节点级注' }
  ];
  writeDisk(SRC, d);
};

/* ============================================================
 * §D 读口不退化：形状**只增字段**
 * ============================================================ */
describe('D · 读口只增字段：条目级的边多 item/itemLabel，节点级的边一个字段都不多', () => {
  beforeAll(() => { plantAd(); });
  afterAll(() => { plantAd(); });   // 复原（D 段自己是干净的，免得给后面的段留脏状态）

  it('D1 `links --json`：条目级边带 item；节点级边**没有** item 键', () => {
    const r = run('links', SRC, '--json');
    expect(r.code).toBe(0);
    const out = json(r.out);
    const rows = out.links.filter((l) => l.node === AD);
    expect(rows.length).toBe(3);
    const nodeLevel = rows.find((l) => relations.itemKey(l.item) === '');
    expect(nodeLevel).toBeTruthy();
    expect('item' in nodeLevel).toBe(false);                 // ← 老形状：一个字段都不多
    const itemLevel = rows.filter((l) => relations.itemKey(l.item));
    expect(itemLevel.map((l) => l.item).sort()).toEqual([IA, IB].sort());
    expect(itemLevel.every((l) => typeof l.caption === 'string')).toBe(true);
    expect(out.itemEdges.count).toBeGreaterThanOrEqual(2);   // 预算：条目级边数可问出来
    expect(out.itemEdges.ids).toContain(AD + '#' + IA);
  });

  it('D2 `links` 文本行：条目级边写成 `目标/节点#条目`，节点级那条**不带 #**', () => {
    const r = run('links', SRC);
    expect(r.code).toBe(0);
    expect(r.out).toContain(DST + '/' + T + '#' + IA);
    expect(r.out).toContain(DST + '/' + T + '#' + IB);
    expect(r.out).toContain(AD + ' → ' + DST + '/' + T_EMPTY + '  ');
    expect(r.out).not.toContain(DST + '/' + T_EMPTY + '#');
  });

  it('D3 `backlinks --json`（目标节点视角）：两档**一起给**，条目行多 item + itemLabel', () => {
    // 先自证前提：AD 那两条条目级边确实在盘上（本段不依赖前面的段落跑过）
    expect(edgesOf(AD).filter((l) => l.id === T).length).toBe(2);
    const r = run('backlinks', DST, T, '--json');
    expect(r.code).toBe(0);
    const out = json(r.out);
    // **跨项目**的入边进 `cross`（`within` 只收本项目内的来源）—— 判据按契约的分档走
    const rows = out.cross.filter((x) => x.node === AD);
    expect(rows.length).toBe(2);                              // 该源节点对 T 的两条都是条目级
    expect(rows.every((x) => x.item)).toBe(true);
    expect(rows.map((x) => x.item).sort()).toEqual([IA, IB].sort());
    // itemLabel 是**给人看的**（标签优先）—— 条目甲带 tags: 门禁,检索
    const rowA = rows.find((x) => x.item === IA);
    expect(rowA.itemLabel).toContain(IA);
    expect(rowA.itemLabel).toContain('门禁');
    // 条目乙没有 tags ⇒ 摘录正文
    const rowB = rows.find((x) => x.item === IB);
    expect(rowB.itemLabel).toContain('乙条正文');
    // **节点级那条没被条目级顶掉**：同一个源节点对 T_EMPTY 的边仍是老形状
    const r2 = run('backlinks', DST, T_EMPTY, '--json');
    expect(r2.code).toBe(0);
    const rowC = json(r2.out).cross.find((x) => x.node === AD);
    expect(rowC).toBeTruthy();
    expect('item' in rowC).toBe(false);
  });

  it('D4 `related --json`：条目级出边带 item + itemLabel；一跳计数与节点级口径一致（图不变）', () => {
    const r = run('related', SRC, AD, '--json');
    expect(r.code).toBe(0);
    const out = json(r.out);
    const outRow = out.items.find((x) => x.dir === 'out' && x.node === T);
    expect(outRow).toBeTruthy();
    expect(outRow.item).toBeTruthy();
    expect(typeof outRow.itemLabel).toBe('string');
    // 图结构不变：**带 item 的边仍然画在节点之间** —— 出边目标集合 = {T, T_EMPTY}，
    // 条目层一个节点都没多（对 T 的两条条目级边合成一跳里的一行）
    expect(out.items.filter((x) => x.dir === 'out').map((x) => x.node).sort()).toEqual([T, T_EMPTY].sort());
    expect(out.outCount).toBe(2);
  });

  it('D5 v2 数据（没有任何 item）读口输出**逐字节不变**：一个新增键都不许有', () => {
    // 造一个**干净的老式项目**（只有节点级边、没有任何 items）—— 这才是"v2 兼容"的判据
    const OLD = 'it-s6-old';
    expect(run('init', OLD, '--title', 'S6 老数据探针').code).toBe(0);
    expect(run('add', OLD, 'root', '--topic', 'S6 老源', '--id', 'it-s6-o1').code).toBe(0);
    expect(run('add', SRC, 'root', '--topic', 'S6 老目标', '--id', 'it-s6-o2').code).toBe(0);
    expect(run('link', OLD, 'it-s6-o1', '--to', SRC, '--id', 'it-s6-o2', '--caption', '老式说明').code).toBe(0);
    // 出边读口：一个字段都不多
    const r1 = run('links', OLD, '--json');
    expect(r1.code).toBe(0);
    const row1 = json(r1.out).links[0];
    expect(Object.keys(row1).sort()).toEqual(['caption', 'id', 'node', 'project', 'topic']);
    expect(json(r1.out).itemEdges).toEqual({ count: 0, ids: [] });
    // 入边读口（backlinks）：行形状与 v2 逐字相同
    const r2 = run('backlinks', SRC, 'it-s6-o2', '--json');
    expect(r2.code).toBe(0);
    const row2 = json(r2.out).cross.find((x) => x.node === 'it-s6-o1');
    expect(row2).toBeTruthy();
    expect(Object.keys(row2).sort()).toEqual(['caption', 'node', 'project', 'topic']);
    // relation 读口（related）：行形状与 v2 逐字相同
    const r3 = run('related', OLD, 'it-s6-o1', '--json');
    expect(r3.code).toBe(0);
    const row3 = json(r3.out).items.find((x) => x.node === 'it-s6-o2');
    expect(Object.keys(row3).sort()).toEqual(['caption', 'depth', 'dir', 'node', 'project', 'topic', 'via']);
  });
});

/* ============================================================
 * §E 悬挂：判据一处 + 清理出口 + **注入证明**
 * ============================================================ */
describe('E · 条目级悬挂：判据（纯函数）与清理出口（CLI）互相印证', () => {
  it('E1 纯函数判据：节点在、条目不在 ⇒ refState 报 no-item 并点名 `项目/节点#条目`', () => {
    const root = readDiskProj(DST);
    const bad = relations.refState({ project: DST, id: T, item: 'i-gone' }, root, DST);
    expect(bad.state).toBe('no-item');
    expect(bad.label).toBe(DST + '/' + T + '#i-gone');
    expect(bad.hint).toContain('i-gone');
    expect(bad.hint).toContain(IA);                    // 现有条目要点名（"少了哪一条"必须看得见）
    // 同一条条目还在 ⇒ ok；节点不在 ⇒ no-node（**两档分开报**，修法才指得对）
    expect(relations.refState({ project: DST, id: T, item: IA }, root, DST).state).toBe('ok');
    expect(relations.refState({ project: DST, id: 'it-s6-nope', item: IA }, root, DST).state).toBe('no-node');
    // 项目读不出来 ⇒ unreadable（**不算悬空**：采不到真值就不猜）
    expect(relations.refState({ project: DST, id: T, item: IA }, null, DST).state).toBe('unreadable');
  });

  it('E2 判据的另一半：targetHasItem 是"条目在不在"的**同一份**实现（schema 也调它）', () => {
    const node = nodeOf(readDisk(DST), T);
    expect(relations.targetHasItem(node, IA)).toEqual({ ok: true, ids: [IA, IB, IP] });
    expect(relations.targetHasItem(node, 'i-gone')).toEqual({ ok: false, ids: [IA, IB, IP] });
    // 没有条目层的节点：节点级引用恒真（不该因为它没有 items 就判红）
    expect(relations.targetHasItem(nodeOf(readDisk(DST), T_EMPTY), '').ok).toBe(true);
    expect(relations.targetHasItem(nodeOf(readDisk(DST), T_EMPTY), IA).ok).toBe(false);
  });

  it('E3 ★注入证明：把"条目级那一档"关掉 ⇒ 同一个输入必须翻成 ok（断言有判别力，不是在空转）', () => {
    const root = readDiskProj(DST);
    const ref = { project: DST, id: T, item: 'i-gone' };
    expect(relations.refState(ref, root, DST).state).toBe('no-item');
    const tampered = JSON.parse(JSON.stringify(root));
    // 注入：把**那一条坏引用**换成"指向存在的那一条" ⇒ 判据必须立刻闭嘴（ok）。
    // 这就是"条目级那一档真的在按 item 值判"的证明 —— 若判据写成"忽略 item"，这一条会红。
    expect(relations.refState({ project: DST, id: T, item: IA }, tampered, DST).state).toBe('ok');
    // 反向：目标节点不存在时，**带不带 item 都是 no-node**（条目档不许改变节点级结论）
    expect(relations.refState({ project: DST, id: 'it-s6-nope', item: 'i-gone' }, root, DST).state).toBe('no-node');
    expect(relations.refState({ project: DST, id: 'it-s6-nope' }, root, DST).state).toBe('no-node');
    // 反向：目标项目的条目层整体消失（items 键没了）⇒ 仍是 no-item（"节点在、条目不在"）
    delete nodeOf({ data: tampered }, T).items;
    expect(relations.refState(ref, tampered, DST).state).toBe('no-item');
    // 而同一份"没有条目层"的数据上，**节点级引用**照旧 ok（它没要求条目层）
    expect(relations.refState({ project: DST, id: T }, tampered, DST).state).toBe('ok');
  });

  it('E4 `links-prune --dry-run`：如实点名"节点还在、条目已被删"，且**不写盘**', () => {
    plantEdge(A, { project: DST, id: T, item: 'i-gone' });          // 造一条坏边（节点在、条目不在）
    const before = readText(SRC);
    const r = run('links-prune', SRC, '--dry-run');
    expect(r.code).toBe(0);
    expect(r.out).toContain('发现悬挂链接');
    expect(r.out).toContain(DST + '/' + T + '#i-gone');
    expect(r.out).toContain('节点还在、条目已被删');                 // ← 这一档必须**单独点明**
    expect(r.out).toContain('[dry-run]');
    expect(readText(SRC)).toBe(before);                            // dry-run 不写盘
    expect(edgeTo(A, T, 'i-gone')).not.toBeNull();
  });

  it('E5 `links-prune` 真跑：剪掉那条坏边、**保留**同目标上好的那些边，且 validate 复绿', () => {
    const r = run('links-prune', SRC);
    expect(r.code).toBe(0);
    expect(r.out).toContain('已删除链接: ' + A + ' → ' + DST + '/' + T + '#i-gone');
    expect(edgeTo(A, T, 'i-gone')).toBeNull();
    // 同节点上指向**同样目标**、但条目层完好的那些边**一条都不许少**（键含条目层的意义）
    expect(edgesOf(A2).length).toBe(3);
    const v = run('validate', SRC);
    expect(v.code).toBe(0);
  });

  it('E6 剪完之后再跑一次：没有可清理的 ⇒ 明说"无需清理"且零写入（幂等）', () => {
    const before = readText(SRC);
    const r = run('links-prune', SRC);
    expect(r.code).toBe(0);
    expect(r.out).toContain('没有悬挂链接，无需清理');
    expect(readText(SRC)).toBe(before);
  });

  it('E7 `links-prune --items`：精确档按 `节点id#条目id` 点名，只删**那一条**边', () => {
    // 自给自足：给 A2 造两条同样指向 (DST,T) 但条目不同的边 —— 正是"精确档"要能分辨的形状
    const d = readDisk(SRC);
    nodeOf(d, A2).links = [
      { project: DST, id: T, item: IA, caption: '甲（不该被 --items T#IB 碰）' },
      { project: DST, id: T, item: IB, caption: '乙（待清）' }
    ];
    writeDisk(SRC, d);
    const r = run('links-prune', SRC, '--items', T + '#' + IB);
    expect(r.code).toBe(0);
    expect(r.out).toContain('按 --items 清理');
    expect(edgeTo(A2, T, IB)).toBeNull();               // 被点名的那一条：剪掉
    expect(edgeTo(A2, T, IA)).not.toBeNull();           // 同目标、另一条条目：**一条都没动**
    expect(edgesOf(A2).length).toBe(1);
    // 格式写错 ⇒ 响亮拒绝（不许静默当成"没有可清理的"）
    const bad = run('links-prune', SRC, '--items', 'no-hash-here');
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain('节点id#条目id');
  });
});

/* ============================================================
 * §F 被指向的条目被删：**默认拒绝并点名**（S2 的删侧 + S6 的清侧合起来闭环）
 * ============================================================ */
describe('F · `item-remove` 与条目级链接的闭环（S2 的删侧 + S6 的清侧）', () => {
  beforeAll(() => {
    // ⚠️ **引用检查只在"同项目内的 links"上做**（`item-remove` 只看本项目 data 里的 links）：
    // 跨项目的引用者，本项目**看不见** —— 那一侧只能由引用者自己跑 `links-prune`
    // （契约 §3.2 的原文：`若引用者在别的项目里，本项目看不见它`）。所以这条闭环的夹具
    // 必须把边造在**同一个项目**里（这与 E5 的"跨项目"档正好互补，两边都要有断言）。
    const d = readDisk(DST);
    nodeOf(d, T_EMPTY).links = [
      { project: DST, id: T, item: IB, caption: '同项目内指向乙条' },
      { project: DST, id: T, item: IA, caption: '同项目内指向甲条（不该被连坐）' }
    ];
    writeDisk(DST, d);
  });

  it('F1 被本项目的 `links[].item` 引用 ⇒ 默认拒绝、点名引用者、盘上零改动；`--clean-links` 才放行', () => {
    expect(edgeTo(T_EMPTY, T, IB, DST)).not.toBeNull();   // 前提先证明
    const before = readText(DST);
    const rBad = run('item-remove', DST, T, IB);
    expect(rBad.code).not.toBe(0);
    expect(rBad.out).toContain('悬挂引用');
    expect(rBad.out).toContain(T_EMPTY);                 // 点名引用者（是哪个节点上的哪条边）
    expect(rBad.out).toContain('--clean-links');         // 给出路
    expect(readText(DST)).toBe(before);                  // 拒绝 = 零写入
    expect(nodeOf(readDisk(DST), T).items.map((x) => x.id)).toContain(IB);

    const rOk = run('item-remove', DST, T, IB, '--clean-links');
    expect(rOk.code).toBe(0);
    expect(nodeOf(readDisk(DST), T).items.map((x) => x.id)).not.toContain(IB);   // 乙条没了
    expect(nodeOf(readDisk(DST), T).items.map((x) => x.id)).toContain(IA);       // 甲条还在
    expect(edgeTo(T_EMPTY, T, IB, DST)).toBeNull();      // 引用被连带剪掉
    expect(edgeTo(T_EMPTY, T, IA, DST)).not.toBeNull();  // 指向**还在的**条目那条不受影响
  });

  it('F2 ★闸门已落地（本条原为"缺口探针"，补丁落地后**已反转**）：条目级悬挂 ⇒ validate **非 0** 且点名 `项目/节点#条目`', () => {
    // 史料（留住，别删）：契约 §9 把"链接/关联的条目级悬挂"的**判定**归给 `src/schema.js`（G2），
    // 而**补丁前**那份文件只判节点级（`nodeExists` 只有节点档、拿不到目标节点的 `items`）。
    // 于是本条原先是一句**守旧事实的断言**：`expect(v.code).toBe(0)`，钉住的是"缺口的存在"
    // —— 真悬挂、闸门却是绿的。补丁（`targetNodeOf` + `targetHasItem`；判据仍只有
    // `src/relations.js` 那一份，本文件不新增第二处）落地后缺口已补，本条**同批反转**；
    // 若不反转，它会长期替一个已经不存在的现状站岗。
    plantEdge(A2, { project: DST, id: T, item: 'i-gone' });
    const v = run('validate', SRC);
    expect(v.code).not.toBe(0);                          // ← 缺口已补：真悬挂必须判红
    expect(v.out).toContain(DST + '/' + T + '#i-gone');  // 且**点名到条目**（不许只写节点 id）
    expect(v.out).toContain('节点还在、条目已被删');      // 与"节点整个不在"分开报（修法不同）
    // 并且**修法在**：S6 自己的清理出口认得它（判据一处：refState）
    const r = run('links-prune', SRC, '--dry-run');
    expect(r.code).toBe(0);
    expect(r.out).toContain('节点还在、条目已被删');
    expect(r.out).toContain(DST + '/' + T + '#i-gone');
    expect(run('links-prune', SRC).code).toBe(0);
    expect(edgeTo(A2, T, 'i-gone')).toBeNull();
    // 反转的**撤销半步**（注入证明：让闸门红的**正是**这条坏边，不是别的东西）
    plantEdge(A2, { project: DST, id: T, item: IA });
    expect(run('validate', SRC).code).toBe(0);
    expect(edgeTo(A2, T, IA)).not.toBeNull();
  });

  it('F3 ★一致性：CLI 的清理判据与纯函数 `refState` 对同一输入给**同一结论**', () => {
    // 造两条不同的坏边：一条条目级坏、一条节点级坏（真·节点不存在）；
    // 另造一条**好边**当对照（"不许误剪"的那一半也要有判据）
    plantEdge(A, { project: DST, id: T, item: 'i-gone-2' });
    plantEdge(A, { project: DST, id: 'it-s6-nope', caption: '节点级悬挂' });
    plantEdge(A, { project: DST, id: T, item: IA, caption: '好的边（指向还在的条目）' });
    const root = readDiskProj(DST);
    // 纯函数怎么说
    expect(relations.refState({ project: DST, id: T, item: 'i-gone-2' }, root, DST).state).toBe('no-item');
    expect(relations.refState({ project: DST, id: 'it-s6-nope' }, root, DST).state).toBe('no-node');
    expect(relations.refState({ project: DST, id: T, item: IA }, root, DST).state).toBe('ok');
    // CLI 就怎么报（同一条命令、同一份数据）
    const r = run('links-prune', SRC, '--dry-run');
    expect(r.code).toBe(0);
    expect(r.out).toContain(DST + '/' + T + '#i-gone-2');
    expect(r.out).toContain(DST + '/it-s6-nope');
    expect(r.out).toContain('节点还在、条目已被删');
    // 且它剪的对象**正是**判据说"不在"的那些（不是多剪也不是少剪）
    expect(run('links-prune', SRC).code).toBe(0);
    expect(edgeTo(A, T, 'i-gone-2')).toBeNull();
    expect(edgeTo(A, 'it-s6-nope', '')).toBeNull();
    expect(edgeTo(A, T, IA)).not.toBeNull();            // 好的边（同一个目标节点）一条不少
    expect(run('validate', SRC).code).toBe(0);
  });
});

/* ============================================================
 * §G 标签两级：节点级与条目级**并存且可分辨**
 * ============================================================ */
describe('G · 标签两级（节点级 tags / 条目级 item.tags）不合并、不互相复制', () => {
  it('G1 目标节点的条目带 tags，而节点级 tags 里**没有**它 —— 两级各说各的', () => {
    const node = nodeOf(readDisk(DST), T);
    expect(node.items.find((x) => x.id === IA).tags).toEqual(['门禁', '检索']);
    expect(node.tags).toBeUndefined();                  // 条目级标签**不反向复制**进节点 tags
  });

  it('G2 `search --tag` 两档都能命中，且 matchIn 分得清是条目级还是节点级', () => {
    // 纯标签检索（不叠关键词），命中一律指向**条目**（契约 §3.4）
    const r1 = run('search', DST, '--tag', '门禁', '--json');
    expect(r1.code).toBe(0);
    const hit1 = json(r1.out).hits.find((h) => h.itemId === IA);
    expect(hit1).toBeTruthy();
    expect(hit1.matchIn).toBe('item-tag');
    // 给节点打一个**只挂在节点上**的标签：同一档检索必须报 node-tag（两档**可分辨**）
    expect(run('edit', DST, T, '--tags', '节点级标签X').code).toBe(0);
    const r2 = run('search', DST, '--tag', '节点级标签X', '--json');
    expect(r2.code).toBe(0);
    const hit2 = json(r2.out).hits.find((h) => h.nodeId === T);
    expect(hit2).toBeTruthy();
    expect(hit2.matchIn).toBe('node-tag');
    // 两级**各自独立**：条目级的那个标签没有跑进节点 tags，节点级的也没跑进 item.tags
    const node = nodeOf(readDisk(DST), T);
    expect(node.tags).toEqual(['节点级标签X']);
    expect(node.items.find((x) => x.id === IA).tags).toEqual(['门禁', '检索']);
  });
});
