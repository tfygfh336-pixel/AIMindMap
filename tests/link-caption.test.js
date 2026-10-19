/* ============================================================
 * tests/link-caption.test.js — 重复 `link` 的 caption 语义（K8 修复的回归锁）
 * ------------------------------------------------------------
 * 缺陷（真机复现，见 `.review/20261010-卖点与功能-常驻讨论/K8-复现与读数.md`）：
 *   同一条边第二次 `link` 且**不给** `--caption` ⇒ 盘上 `links[]` 从
 *   `{project,id,caption}` 变成 `{project,id}`（说明没了、无任何提示），
 *   而回显与第一次**逐字相同**（`已添加链接: …`）⇒ **成功与覆盖不可分辨** ✗。
 *
 * 本文件锁住的语义（每条都对应一种"看起来成功、其实做了别的事"）：
 *   ① 首次添加（含不给 caption / 给 caption）—— 落盘形状与回显与从前一致；
 *   ② 省略 --caption 重放 ⇒ 落盘**逐字节不变**，且**不产生空写入**（项目文件字节也不变）；
 *   ③ 显式 --caption "" ⇒ caption 被清空，回显点明"已更新"+"caption 清空"；
 *   ④ 显式 --caption 新值 ⇒ 覆盖（回显带 old→new）；同值重放 ⇒ "无变化"；
 *   ⑤ 边上的其它字段（历史实测会被旧写法顺手抹掉的 `note`）与**数组顺序**都不被动；
 *   ⑥ 只写 `--caption` 不给值 ⇒ 响亮拒绝（旧写法会把 `true` 原样写进链接）。
 *
 * ⚠️ 两个环境要点（改这个文件前先读）：
 *   1) **绝不许碰真实 `projects/`**：`AI_MINDMAP_PROJECTS_DIR` 必须在 `require cli/main.js`
 *      **之前**设好 —— `cli/core.js` 的 `PROJECTS_DIR` 是**模块加载时**定型的（core.js:38）。
 *      故本文件在加载时先自证重定向生效，不生效就**当场红**，绝不"先跑起来再说"。
 *   2) **不起子进程**：本工程记过"受限环境（企业 EDR/沙箱）下管道 stdio 会 EPERM 假失败"
 *      （见 docs/VERIFY.md）。故用进程内 `invokeSync`（与 `tests/cli-main.test.js` 同一口径）。
 * ============================================================ */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);

/* ---- ① 先在临时目录上建项目根（必须在 require cli/main.js 之前） ----
 * ⚠️ 收尾（2026-10-19 实测的病）：这个目录在**模块加载时**就建好、整个文件共用，
 *   旧实现建完之后**完全没收尾** ⇒ 一次 `vitest run` 就在 `%TEMP%` 里留一个 `mm-k8-*`。
 *   ⇒ 改走公共件（创建即登记 + 文件末尾 `afterAll`），清理形态与语义见 `tests/_tmp-cleanup.js`。 */
const TMP_ROOT = makeTmp('mm-k8-');
process.env.AI_MINDMAP_PROJECTS_DIR = TMP_ROOT;
const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');

/* 重定向必须**当场**生效：否则夹具会建进真实 `projects/` —— 这是最坏的一类错误
 * （测试污染真实数据），所以宁可在这里响亮地红，也不继续往下走。 */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(TMP_ROOT)) {
  throw new Error('项目根重定向未生效（cli/core.js 已被更早加载）：PROJECTS_DIR='
    + core.PROJECTS_DIR + ' 期望=' + TMP_ROOT + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

/* 收尾只此一处：删掉本文件建的那一个项目根（失败**响亮但不判红**，见公共件头部）。 */
afterAll(cleanupAll);

const SRC = 'it-k8-src';
const DST = 'it-k8-dst';
const NODE = 'it-k8-a';        // 源节点（承载 links）
const T1 = 'it-k8-b';          // 目标节点一
const T2 = 'it-k8-c';          // 目标节点二（用来钉"顺序不被重排"）
const NODE_FRESH = 'it-k8-d';  // 首次添加（不给 caption）用的源节点
const CAP = '出自：K8 复现脚本（AI 凭 caption 判断内容）';

const projFile = (name) => path.join(TMP_ROOT, name, name + '.json');
const readText = (name) => fs.readFileSync(projFile(name), 'utf8');
const readDisk = (name) => JSON.parse(readText(name));
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
const edgesOf = (nodeId) => nodeOf(readDisk(SRC), nodeId).links || [];
/** 指向目标的那条边 */
const edgeTo = (nodeId, target) => edgesOf(nodeId).find((l) => l.project === DST && l.id === target) || null;

/** 跑一条命令（进程内、同步）：返回 { code, out }（stdout+stderr 合并，与集成脚本同口径） */
const run = (...args) => {
  const r = invokeSync(args);
  return { code: r.code, out: (r.stdout + r.stderr).trim() };
};

beforeAll(() => {
  expect(run('init', SRC, '--title', 'K8 探针源').code).toBe(0);
  expect(run('init', DST, '--title', 'K8 探针目标').code).toBe(0);
  expect(run('add', SRC, 'root', '--topic', 'K8 源节点', '--id', NODE).code).toBe(0);
  expect(run('add', SRC, 'root', '--topic', 'K8 首次添加节点', '--id', NODE_FRESH).code).toBe(0);
  expect(run('add', DST, 'root', '--topic', 'K8 目标一', '--id', T1).code).toBe(0);
  expect(run('add', DST, 'root', '--topic', 'K8 目标二', '--id', T2).code).toBe(0);
});

describe('link 沙箱前提（先自证，再断言）', () => {
  it('项目根已被重定向到临时目录 —— 这个文件绝不许写真实 projects/', () => {
    expect(path.resolve(core.PROJECTS_DIR)).toBe(path.resolve(TMP_ROOT));
    expect(fs.existsSync(projFile(SRC))).toBe(true);
    expect(fs.existsSync(projFile(DST))).toBe(true);
  });
});

describe('link 首次添加：形状与回显与从前一致', () => {
  it('带 --caption：回显仍是「已添加链接: …」，caption 落盘', () => {
    const r = run('link', SRC, NODE, '--to', DST, '--id', T1, '--caption', CAP);
    expect(r.code).toBe(0);
    expect(r.out).toContain('已添加链接: ' + NODE + ' → ' + DST + '/' + T1);
    expect(edgeTo(NODE, T1)).toEqual({ project: DST, id: T1, caption: CAP });
  });

  it('不给 --caption：**不落** caption 键（与旧写法逐字一致，不写空串）', () => {
    const r = run('link', SRC, NODE_FRESH, '--to', DST, '--id', T1);
    expect(r.code).toBe(0);
    expect(r.out).toContain('已添加链接: ');
    expect(edgeTo(NODE_FRESH, T1)).toEqual({ project: DST, id: T1 });
  });
});

describe('★省略 --caption 重放：caption 必须被保留，且不产生空写入', () => {
  it('落盘 links 逐字节不变（含 caption）—— 这是本缺陷的正题', () => {
    const before = JSON.stringify(edgesOf(NODE));
    const r = run('link', SRC, NODE, '--to', DST, '--id', T1);   // 第二次，不给 --caption
    expect(r.code).toBe(0);
    expect(edgeTo(NODE, T1).caption).toBe(CAP);
    expect(JSON.stringify(edgesOf(NODE))).toBe(before);
  });

  it('回显可分辨：是「无变化」，**不是**与首次逐字相同的「已添加链接」', () => {
    const r = run('link', SRC, NODE, '--to', DST, '--id', T1);
    expect(r.code).toBe(0);
    expect(r.out).toContain('无变化');
    expect(r.out).not.toContain('已添加链接');
    expect(r.out).toContain(NODE + ' → ' + DST + '/' + T1);
    expect(r.out).toContain(CAP);        // 保留下来的那份说明要看得见（"静默保留"也是不可见的一种）
  });

  it('不产生空写入：项目文件字节也不变（否则 .changes.jsonl 会多一条假信号）', () => {
    const before = readText(SRC);
    const r = run('link', SRC, NODE, '--to', DST, '--id', T1);
    expect(r.code).toBe(0);
    expect(readText(SRC)).toBe(before);
  });
});

describe('★显式 --caption（含空串）：覆盖，且回显可分辨', () => {
  it('显式空串 ⇒ caption 被清空，回显点明「已更新」+「caption 清空」', () => {
    const before = readText(SRC);
    const r = run('link', SRC, NODE, '--to', DST, '--id', T1, '--caption', '');
    expect(r.code).toBe(0);
    expect(r.out).toContain('已更新链接');
    expect(r.out).toContain('caption 清空');
    expect(r.out).not.toContain('已添加链接');
    const e = edgeTo(NODE, T1);
    expect(e.project).toBe(DST);                 // 边还在（清空的是说明，不是链接）
    expect(e.id).toBe(T1);
    expect('caption' in e).toBe(false);          // 清空 = 不留空串键
    expect(readText(SRC)).not.toBe(before);      // 这次是**真的**写下去了
  });

  it('清空后重放 ⇒ 「无变化」且盘上零改动（幂等）', () => {
    const before = readText(SRC);
    const r = run('link', SRC, NODE, '--to', DST, '--id', T1, '--caption', '');
    expect(r.code).toBe(0);
    expect(r.out).toContain('无变化');
    expect(readText(SRC)).toBe(before);
  });

  it('显式新说明 ⇒ 覆盖，回显带 old → new（覆盖这件事必须看得见）', () => {
    const r = run('link', SRC, NODE, '--to', DST, '--id', T1, '--caption', '改过的说明');
    expect(r.code).toBe(0);
    expect(r.out).toContain('已更新链接');
    expect(r.out).toContain('改过的说明');
    expect(r.out).toContain('无');               // 「（无）→ 改过的说明」：覆盖前的空状态也写出来
    expect(edgeTo(NODE, T1).caption).toBe('改过的说明');
  });

  it('同说明重放 ⇒ 「无变化」，不是第二次「已更新」', () => {
    const before = readText(SRC);
    const r = run('link', SRC, NODE, '--to', DST, '--id', T1, '--caption', '改过的说明');
    expect(r.code).toBe(0);
    expect(r.out).toContain('无变化');
    expect(r.out).not.toContain('已更新链接');
    expect(readText(SRC)).toBe(before);
  });
});

describe('link 不碰它没被要求碰的东西', () => {
  it('同节点上的第二条边：更新其中一条**不重排**数组（其它边的字节位置不变）', () => {
    expect(run('link', SRC, NODE, '--to', DST, '--id', T2, '--caption', '第二条边').code).toBe(0);
    expect(edgesOf(NODE).map((l) => l.id)).toEqual([T1, T2]);

    const r = run('link', SRC, NODE, '--to', DST, '--id', T1, '--caption', '更新第一条');
    expect(r.code).toBe(0);
    expect(r.out).toContain('已更新链接');
    // 旧写法会 filter+concat ⇒ 被更新的那条被挪到末尾（顺序变了 = 别人 diff 里多两行噪音）
    expect(edgesOf(NODE).map((l) => l.id)).toEqual([T1, T2]);
    expect(edgeTo(NODE, T2).caption).toBe('第二条边');
  });

  it('边上的其它字段（如 note）在改 caption 时不被顺手抹掉（只在原对象上改一个键）', () => {
    // 夹具：手工给边加一个契约之外但真实存在的字段 —— 旧写法会整个重建对象，把 note 抹掉
    const d = readDisk(SRC);
    const e = (nodeOf(d, NODE).links || []).find((l) => l.project === DST && l.id === T1);
    e.note = '手工附在这条边上的笔记';
    fs.writeFileSync(projFile(SRC), JSON.stringify(d, null, 2), 'utf8');

    const r = run('link', SRC, NODE, '--to', DST, '--id', T1, '--caption', '再改一次');
    expect(r.code).toBe(0);
    expect(r.out).toContain('已更新链接');
    const after = edgeTo(NODE, T1);
    expect(after.caption).toBe('再改一次');
    expect(after.note).toBe('手工附在这条边上的笔记');   // ← 旧写法这里必红
  });
});

describe('link 非法入参：响亮拒绝且零写入', () => {
  it('只写 --caption 不给值 ⇒ 报错（旧写法会把 `true` 写进 caption）且盘上零改动', () => {
    const before = readText(SRC);
    const r = run('link', SRC, NODE, '--to', DST, '--id', T1, '--caption');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('--caption 需要一个说明文本');
    expect(readText(SRC)).toBe(before);
  });
});
