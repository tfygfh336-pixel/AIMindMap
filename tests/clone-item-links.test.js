/* ============================================================
 * tests/clone-item-links.test.js — 克隆时**条目级边**（`links[].item`）的三态语义
 * 运行：npx vitest run tests/clone-item-links.test.js
 * ------------------------------------------------------------
 * 守的是什么（一个语义岔口，三档口径全部可执行）：
 *   副本上的条目 **id 重新签发**（全项目唯一，`docs/ITEM-MODEL.md` §5.1），于是副本上那些条目级边
 *   要回答一个问题：**它们该指哪一条条目？** 口径（`docs/EXTENSIONS.md` §1.2）：
 *     ① **默认 = 引用语义**：边**逐字仍指原物**，克隆不改它 —— 但它必须**看得见**
 *        （`--json` 的 `itemEdges.kept` 逐条点名；文本档**仅当副本上真有这类边**时多一行）；
 *     ② `--repoint-items` = **语义改变**：改指**副本自己那份新条目**的**同序号**条目
 *        （目标节点 + 条目**两端一起换**；只换 item 会立刻悬挂 —— 夹具里那条断言就是钉它的）；
 *     ③ **对不上就拒绝并点名**（目标在别的项目 / 目标不在被复制范围 / 那个节点里没有这条条目）；
 *     ⑤ 副本上**没有**这类边 ⇒ 文本输出与从前**逐字相同**（不许给普通克隆加噪音）。
 *
 * ## 判别力（注入证明的可执行面）
 *   ④ 把"重指向"改成**静默按序号对齐**（对不上的边也照样挑一条同下标的条目塞进去）⇒
 *      「丙组」的两条断言（③ 必须 exit 1 + 点名；`planItemEdges` 对这类边**不许给 `to`**）**必红**。
 *      实测报文与还原后的复绿读数见本批交付说明；还原 = 删掉那段注入、文件 SHA-256 回到原值。
 *
 * ⚠️ 两个环境要点（与 `tests/clone-field-copy.test.js` 同一口径，改这个文件前先读）：
 *   1) **绝不许碰真实 `projects/`**：`AI_MINDMAP_PROJECTS_DIR` 必须在 `require cli/main.js`
 *      **之前**设好（`cli/core.js` 的 `PROJECTS_DIR` 是**模块加载时**定型的）⇒ 先在下面自证重定向生效。
 *   2) **不起子进程**：端到端用进程内 `invokeSync`（受限环境下管道 stdio 会 EPERM 假失败）。
 * ============================================================ */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/* ---- ① 先在临时目录上建项目根（必须在 require cli/main.js 之前） ---- */
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-clone-links-'));
process.env.AI_MINDMAP_PROJECTS_DIR = TMP_ROOT;
const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const editCmd = require('../cli/commands/edit.js');
const { renderDetail } = require('../src/item-model.js');

if (path.resolve(core.PROJECTS_DIR) !== path.resolve(TMP_ROOT)) {
  throw new Error('项目根重定向未生效（cli/core.js 已被更早加载）：PROJECTS_DIR='
    + core.PROJECTS_DIR + ' 期望=' + TMP_ROOT + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

const P = 'it-clone-links';          // 本项目
const OTHER = 'it-clone-links-b';    // 另一项目（跨项目边的目标）
const projFile = (p) => path.join(TMP_ROOT, p, p + '.json');
const readProj = (p) => JSON.parse(fs.readFileSync(projFile(p), 'utf8'));
const run = (...args) => {
  const r = invokeSync(args);
  return { code: r.code, out: (r.stdout + r.stderr).trim() };
};
const json = (r) => { try { return JSON.parse(r.out); } catch (e) { return null; } };
const walk = (p, fn) => { (function w(n) { if (!n) return; fn(n); (n.children || []).forEach(w); })(readProj(p).data); };
const nodeOnDisk = (p, id) => { let hit = null; walk(p, (n) => { if (n.id === id) hit = n; }); return hit; };
const nodesByTopic = (p, topic) => { const out = []; walk(p, (n) => { if (n.topic === topic) out.push(n); }); return out; };
/** 条目级边（有 `item` 的那些）—— 三态语义只对它们成立 */
const itemEdges = (node) => ((node && node.links) || []).filter((l) => typeof l.item === 'string' && l.item);

beforeAll(() => {
  expect(run('init', P, '--title', '条目级边三态').code).toBe(0);
  expect(run('init', OTHER, '--title', '另一项目').code).toBe(0);

  /* 夹具直接写盘：`link` 命令**拒绝自链接**，而本组要的正是"结构合法、只是序号走不通"的形态。
     ⚠️ 条目化节点的 `detail` 是**派生缓存**，必须逐字节 == `renderDetail(items)`，
     否则写盘闸门当场判红（夹具造错了会表现为"命令全都在报校验失败"，看着像产品坏了）。 */
  const d = readProj(P);
  d.data.children.push({
    id: 'outside', topic: '范围外目标', children: [],
    items: [
      { id: 'i-o1', type: 'text', html: '<p>O1</p>' },
      { id: 'i-o2', type: 'text', html: '<p>O2</p>' }
    ]
  });
  d.data.children.push({
    id: 'src', topic: '源节点', children: [{
      id: 'src-kid', topic: '子树内', children: [],
      items: [
        { id: 'i-k1', type: 'text', html: '<p>K1</p>' },
        { id: 'i-k2', type: 'text', html: '<p>K2</p>' }
      ],
      links: [{ project: P, id: 'src-kid', item: 'i-k2', caption: '自指条目' }]
    }],
    items: [
      { id: 'i-s1', type: 'text', html: '<p>S1</p>' },
      { id: 'i-s2', type: 'text', html: '<p>S2</p>' }
    ],
    links: [
      { project: P, id: 'outside', item: 'i-o2', caption: '指向范围外的那条条目' },
      { project: OTHER, id: 'b1', item: 'i-b1' },
      { project: P, id: 'outside', caption: '节点级边（不在这三态里）' }
    ]
  });
  d.data.children.push({ id: 'plain', topic: '无条目级边', children: [] });
  const fix = (n) => { if (Array.isArray(n.items)) n.detail = renderDetail(n.items); (n.children || []).forEach(fix); };
  fix(d.data);
  fs.writeFileSync(projFile(P), JSON.stringify(d, null, 2), 'utf8');

  const db = readProj(OTHER);
  db.data.children.push({ id: 'b1', topic: 'B1', children: [], items: [{ id: 'i-b1', type: 'text', html: '<p>B1</p>' }] });
  fix(db.data);
  fs.writeFileSync(projFile(OTHER), JSON.stringify(db, null, 2), 'utf8');

  expect(run('validate', P).code, '夹具本身必须先是合法的').toBe(0);
});

afterAll(() => { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); });

/* ============================================================
 * 甲组 · ① 默认档：引用语义（边逐字仍指原物）+ "没被重指向"看得见
 * ============================================================ */
describe('甲组 · ① 默认档 = 引用语义（不改它，但必须看得见）', () => {
  it('副本上的条目级边**逐字**仍指原物（与克隆前的值相同），条目 id 则确实换了新', () => {
    const before = JSON.stringify(itemEdges(nodeOnDisk(P, 'src')));
    const r = run('clone', P, 'src', 'root', '--deep');
    expect(r.code, r.out).toBe(0);
    const copy = nodesByTopic(P, '源节点').find((n) => n.id !== 'src');
    expect(copy, '没找到副本（clone 没落地？）').toBeTruthy();
    // 源节点自己的那些边：一字不变
    expect(JSON.stringify(itemEdges(nodeOnDisk(P, 'src')))).toBe(before);
    expect(JSON.stringify(itemEdges(copy))).toBe(before);
    // 子树内那条边也一样（它还指原节点 + 原条目）
    const kidCopy = nodesByTopic(P, '子树内').find((n) => n.id !== 'src-kid');
    expect(kidCopy.links[0].id).toBe('src-kid');
    expect(kidCopy.links[0].item).toBe('i-k2');
    // 而副本上的条目 id 是新的（§5.1）—— "边没指它"与"它是新的"是两件事，都要钉住
    expect(copy.items.map((x) => x.id)).not.toContain('i-s1');
    expect(kidCopy.items.map((x) => x.id)).not.toContain('i-k2');
    expect(run('validate', P).code, '默认档克隆后必须仍然过闸门').toBe(0);
  });

  it('文本档**仅当有这类边**时多一行，且点名"仍指原物"与那条开关', () => {
    const r = run('clone', P, 'src', 'root', '--deep');
    expect(r.code, r.out).toBe(0);
    const lines = r.out.split('\n');
    expect(lines.length, '恰好两行：原回显 + 一行提示').toBe(2);
    expect(lines[0]).toMatch(/^已复制: src → root（新 id src-[^）]+）$/);
    expect(lines[1]).toContain('仍指原物');
    expect(lines[1]).toContain('--repoint-items');
    // 三条边逐条点名（两条在副本根上、一条在子节点上）+ 目标可读标签
    expect(lines[1]).toContain('links[0] → ' + P + '/outside#i-o2');
    expect(lines[1]).toContain('links[1] → ' + OTHER + '/b1#i-b1');
    expect(lines[1]).toContain('links[0] → ' + P + '/src-kid#i-k2');
  });

  it('`--json` 的 `itemEdges.kept` 把"未被重指向"的边**点名正确**（节点/边下标/目标/源条目 + 能不能重指向）', () => {
    const r = run('clone', P, 'src', 'root', '--deep', '--json');
    expect(r.code, r.out).toBe(0);
    const j = json(r);
    expect(j && j.ok && j.repointItems === false).toBe(true);
    expect(j.itemEdges.count).toBe(3);
    expect(j.itemEdges.keptCount).toBe(3);
    expect(j.itemEdges.repointedCount).toBe(0);
    expect(j.itemEdges.repointed).toEqual([]);
    const key = (e) => e.at + ' → ' + e.target;
    const got = j.itemEdges.kept.map(key).sort();
    expect(got).toEqual([
      'links[0] → ' + P + '/outside#i-o2',
      'links[0] → ' + P + '/src-kid#i-k2',
      'links[1] → ' + OTHER + '/b1#i-b1'
    ].sort());
    j.itemEdges.kept.forEach((e) => {
      expect(e.node, '每条都要点名"副本上的哪个节点"').toBeTruthy();
      expect(typeof e.repointable).toBe('boolean');
      if (!e.repointable) expect(e.reason).toMatch(/别的项目|不在本次复制的子树里/);
    });
    // 可重指向的那条：给出"会变成什么"（节点 + 条目两端）
    const kid = j.itemEdges.kept.find((e) => e.item === 'i-k2');
    expect(kid.repointable).toBe(true);
    expect(kid.wouldBe).toMatch(/^src-kid-[a-z0-9-]+#i-k2-[a-z0-9-]+$/);
    expect(kid.ordinal, '同序号 = 源节点里的第 2 条').toBe(2);
  });

  it('节点级边（没有 `item`）在三态之外：既不进清单、也不被统计', () => {
    const r = run('clone', P, 'src', 'root', '--deep', '--json');
    const j = json(r);
    expect(j.itemEdges.count).toBe(3);      // 源节点 3 条链接里只有 2 条带 item（第 3 条是节点级）
    const copy = nodesByTopic(P, '源节点').find((n) => n.id !== 'src');
    expect(copy.links.filter((l) => l.item === undefined).length).toBe(1);
  });
});

/* ============================================================
 * 乙组 · ② `--repoint-items`：改指副本自己的条目，且**能解引用**
 * ============================================================ */
describe('乙组 · ② --repoint-items = 语义改变（两端都换成副本的）', () => {
  it('边改指副本自己的节点 + 条目（两端一起换），`get --item` 读得到那一条', () => {
    // 用"只有可重指向边"的节点：`src-kid` 自指它自己那条 i-k2
    const srcBefore = JSON.stringify(nodeOnDisk(P, 'src-kid'));
    const r = run('clone', P, 'src-kid', 'outside', '--repoint-items', '--json');
    expect(r.code, r.out).toBe(0);
    const j = json(r);
    expect(j.repointItems).toBe(true);
    expect(j.itemEdges.keptCount).toBe(0);
    expect(j.itemEdges.repointedCount).toBe(1);
    const rep = j.itemEdges.repointed[0];
    expect(rep.from).toBe('src-kid#i-k2');
    expect(rep.target, '原物仍然点名（"改了什么"要看得见）').toBe(P + '/src-kid#i-k2');
    expect(rep.ordinal).toBe(2);
    // 盘上的边：**目标节点也是副本**
    const copy = nodesByTopic(P, '子树内').find((n) => n.id !== 'src-kid');
    expect(copy.links[0].id).toBe(copy.id);
    expect(copy.links[0].item).toBe(copy.items[1].id);     // 同序号 = 第 2 条
    expect(copy.links[0].item).not.toBe('i-k2');
    expect(rep.to).toBe(copy.id + '#' + copy.items[1].id);
    // **能解引用**：拿这条边的两端去读，必须读得到那一条（只换 item 的写法到这里会报悬挂）
    const g = run('get', P, copy.id, '--item', copy.links[0].item, '--json');
    expect(g.code, g.out).toBe(0);
    expect(json(g).html).toBe('<p>K2</p>');
    expect(run('validate', P).code).toBe(0);
    expect(JSON.stringify(nodeOnDisk(P, 'src-kid')), '源节点一个字节都不许动').toBe(srcBefore);
  });

  it('文本档把"语义改变"与逐条映射写出来（不是静默改）', () => {
    const r = run('clone', P, 'src-kid', 'outside', '--repoint-items');
    expect(r.code, r.out).toBe(0);
    expect(r.out.split('\n').length).toBe(2);
    expect(r.out).toContain('语义改变');
    expect(r.out).toMatch(/src-kid-[a-z0-9-]+ links\[0\] src-kid#i-k2 → src-kid-[a-z0-9-]+#i-k2-[a-z0-9-]+（同序号 2）/);
  });

  it('`--repoint-items` 是**纯开关**：给了值 ⇒ 响亮拒绝（不许静默当成"下一个位置参数"被吞）', () => {
    const before = fs.readFileSync(projFile(P), 'utf8');
    const r = run('clone', P, 'src-kid', 'root', '--repoint-items=yes');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^error: /);
    expect(r.out).toContain('纯开关');
    expect(fs.readFileSync(projFile(P), 'utf8'), '拒绝时盘上零改动').toBe(before);
  });
});

/* ============================================================
 * 丙组 · ③ 对不上 ⇒ 拒绝并点名（注入④射的就是这一组）
 * ============================================================ */
describe('丙组 · ③ 对不上 ⇒ 整条拒绝 + 逐条点名（盘上零改动）', () => {
  it('目标不在被复制范围 / 跨项目 ⇒ exit 1，两条边都被点名，盘上一个字节没动', () => {
    const before = fs.readFileSync(projFile(P), 'utf8');
    const r = run('clone', P, 'src', 'root', '--deep', '--repoint-items');
    expect(r.code, '对不上必须**拒绝**（不许猜一个序号对齐上去）').toBe(1);
    expect(r.out).toMatch(/^error: /);
    expect(r.out).toContain('对不上');
    expect(r.out).toContain(P + '/outside#i-o2');            // 点名：目标不在被复制范围
    expect(r.out).toContain('不在本次复制的子树里');
    expect(r.out).toContain(OTHER + '/b1#i-b1');             // 点名：跨项目
    expect(r.out).toContain('别的项目');
    expect(r.out).toMatch(/links\[0\]/);                     // 点名：副本上的哪条边
    expect(fs.readFileSync(projFile(P), 'utf8'), '拒绝 = 零写入').toBe(before);
  });

  it('`planItemEdges`：对不上的边**绝不给 `to`**（这条断言就是"静默按序号对齐"的判别力）', () => {
    const src = { id: 's', links: [{ project: 'pp', id: 'out', item: 'i-x' }], items: [], children: [] };
    const copy = { id: 's-c', links: [{ project: 'pp', id: 'out', item: 'i-x' }], items: [], children: [] };
    const plan = editCmd.planItemEdges(editCmd.pairSubtree(src, copy, []), 'pp');
    expect(plan.edges.length).toBe(1);
    expect(plan.edges[0].to, '静默对齐会在这里给一个 id ⇒ 本断言必红').toBe(null);
    expect(plan.edges[0].reason).toContain('不在本次复制的子树里');
    expect(plan.unmatched.length).toBe(1);
  });

  it('**序号对不上**这一档：副本上同下标位置没有条目 ⇒ 点名"序号对不上"，不给 to', () => {
    /* 合成夹具：目标节点在子树里、源里也有那条条目，但**副本那一份的条目数对不上**
       （`cloneItems` 保序 ⇒ 真实路径不该出现；这条守的是"万一出现也不许硬塞一个 id"）。 */
    const src = { id: 's', items: [], children: [{ id: 't', items: [{ id: 'i-1' }, { id: 'i-2' }], children: [] }] };
    src.links = [];
    const copy = { id: 's-c', items: [], children: [{ id: 't-c', items: [{ id: 'i-1-c' }], children: [] }] };
    const t = src.children[0];
    t.links = [{ project: 'pp', id: 't', item: 'i-2' }];
    const copyT = copy.children[0];
    copyT.links = [{ project: 'pp', id: 't', item: 'i-2' }];
    const plan = editCmd.planItemEdges(editCmd.pairSubtree(src, copy, []), 'pp');
    const e = plan.edges.find((x) => x.node === 't-c');
    expect(e.to).toBe(null);
    expect(e.reason).toMatch(/同序号.*序号对不上|序号对不上/);
  });

  it('目标节点里没有那条条目 ⇒ 点名"没有这条条目"并把它现有的条目列出来', () => {
    const src = { id: 's', items: [], children: [{ id: 't', items: [{ id: 'i-1' }, { id: 'i-2' }], children: [] }], links: [] };
    const copy = { id: 's-c', items: [], children: [{ id: 't-c', items: [{ id: 'i-1-c' }, { id: 'i-2-c' }], children: [] }] };
    src.children[0].links = [{ project: 'pp', id: 't', item: 'i-nope' }];
    copy.children[0].links = [{ project: 'pp', id: 't', item: 'i-nope' }];
    const plan = editCmd.planItemEdges(editCmd.pairSubtree(src, copy, []), 'pp');
    expect(plan.edges[0].to).toBe(null);
    expect(plan.edges[0].reason).toContain('没有这条条目');
    expect(plan.edges[0].reason).toContain('i-1, i-2');
  });
});

/* ============================================================
 * 丁组 · ⑤ 副本上没有这类边 ⇒ 输出与从前**逐字相同**（不加噪音）
 * ============================================================ */
describe('丁组 · ⑤ 无条目级边时输出逐字不变', () => {
  it('文本档恰好一行、格式与从前一致（既无 ⚠ 行、也无"条目级"字样）', () => {
    const r = run('clone', P, 'plain', 'root');
    expect(r.code, r.out).toBe(0);
    expect(r.out.split('\n').length).toBe(1);
    expect(r.out).toMatch(/^已复制: plain → root（新 id plain-[a-z0-9-]+）$/);
    expect(r.out).not.toContain('条目级');
  });

  it('`--json` 下 counts 全为 0（JSON 面是新增的，但它必须如实报"没有这类边"）', () => {
    const r = run('clone', P, 'plain', 'root', '--json');
    expect(r.code, r.out).toBe(0);
    const j = json(r);
    expect(j.itemEdges.count).toBe(0);
    expect(j.itemEdges.kept).toEqual([]);
    expect(j.itemEdges.repointed).toEqual([]);
  });

  it('`--repoint-items` 且副本上没有这类边 ⇒ 不多说一个字（开关空转不是"改变"）', () => {
    const r = run('clone', P, 'plain', 'outside', '--repoint-items');
    expect(r.code, r.out).toBe(0);
    expect(r.out.split('\n').length).toBe(1);
    expect(r.out).not.toContain('条目级');
  });
});
