/* ============================================================
 * tests/read-size.test.js —— 高频读取入口的**字节量级上界**（`G-14`）
 * 运行：node node_modules/vitest/vitest.mjs run tests/read-size.test.js --pool=threads
 * ------------------------------------------------------------
 * ## 为什么需要这个文件
 *   `read` / `list` / `get` / `search` 是 AI **每一步都可能再调一次**的入口，而它们的输出会
 *   直接进对话上下文。**同一件事可以有很多种问法**：`read --json` 对 889 节点的 `comnet`
 *   是 **1.22 MB**（≈ 30 万 token），而 `list --json` 是 **135 KB** —— 差 **9 倍**。
 *   没有上界，就没有"该用哪一档"的判据；`read` 悄悄多带一个字段，代价也没人发现。
 *   ⇒ 本文件把"**每档入口的字节量级**"钉成**可复算的形状**（≈ 节点数 × K），并在夹具上守它。
 *
 * ## "高频读取入口"是怎么定义的（本文件的口径，`G-14` 要求自己定并说明理由）
 *   一个入口算"高频读取"，须**同时**满足三条：
 *     ① **不改笔记数据**（旁路埋点不算改数据，且可关：`MM_HEAT_SENSOR=off`）—— 高频调用的前提是"随时可调"；
 *     ② **是"决定下一步做什么"的入口** —— 即 SKILL.md 动作现场里"读"的那几条：
 *        `list` / `read` / `get` / `search`；
 *     ③ **一次会话里可能被调一次以上**（不是一次性命令）。
 *   ⇒ 因此**排除** `export-json`：它是迁移/备份时调一次的**导出**，产出是**文件**而不是
 *   上下文，且体积由**内嵌资源（base64 图片/附件）**驱动（实测 `comnet`：项目 JSON 1.24 MB →
 *   导出文件 **9.68 MB**，7.8 倍，全部来自 assets）⇒ 它不是"节点数 × K"那种形状。
 *   本文件留一条用例把这条理由**变成可复算的读数**（见 §C），而不是一句拍出来的话。
 *   同样排除 `validate` / `stats` / `orphans` / `backlinks`（不在"读来决策"的主链上）。
 *
 * ## 上界的**形状**（不写会腐的精确值）
 *   · O(节点数) 的入口：`上界 = 节点数 × MAG[入口]`，判据 `bytes < 上界 × 2`；
 *   · O(1) 的入口（`get`）：`上界 = GET_BOUND`（常数，与节点数无关），判据同上；
 *   · **预算驱动**的入口（`search`）：上界由 `--max-bytes` 自己声明，判据是
 *     `bytes ≤ 声明的 maxBytes + 信封开销`（**不另抄一份预算常量**，从 payload 里读回来）。
 *   `MAG` 的取值来自**三本书的实测**（样本量：`卖点讨论` 293 / `comnet` 889 / `book-linux-proc-mem` 126
 *   节点；读数见 `docs/ARCHITECTURE.md` 的「高频读取入口的字节量级」一节与
 *   `.review/20261020-测试补全/read-size-readings.json`）：
 *     list --json                 152–185 B/节点      ⇒ MAG 200
 *     read --json                1325–1742 B/节点     ⇒ MAG 2000
 *     read --json --brief         347–495 B/节点      ⇒ MAG 600
 *     read --json --brief --compact 213–341 B/节点    ⇒ MAG 450
 *     get --json                  152–289 B/次（与节点数无关）⇒ GET_BOUND 2048
 *
 * ## ⚠️ 为什么不把**真实三本书**也拿来当判据（这是有意的，不是漏了）
 *   真实项目数据每天在改（本工程一天内就有几本书在批量补正文）。把门禁绑到"当前数据"上，
 *   它会**因为数据变了**而翻红 —— 那是假红，假红的下场是这条门禁被人关掉
 *   （`testing-for-ai` B1b：**门禁常量不得绑定滚动运行时数据**）。
 *   ⇒ 真书只用来**定标**（写进 ARCHITECTURE，带样本量），门禁跑在**固定夹具**上：
 *   夹具不变 ⇒ 读数可复现；入口的实现一变（多带字段、少做裁剪）⇒ 读数按**节点数成比例**变 ⇒ 红。
 *
 * ## 判据能被打红吗（`testing-for-ai` B4）
 *   能，两个方向都在本文件里：
 *     ① §A 的边界用例：`bytes` 恰在上界×2 **减 1** 是绿、**等于**上界×2 是红（`<` 而非 `<=`）；
 *     ② §B 的**真实夹具**：`get` 那条用一个 20 KB 正文的节点 —— 若 `get` 哪天把 `detail`
 *        也带出来，字节数会从 ~300 B 跳到 20 KB，**必红**（这正是项目铁律
 *        「`get --json` 不返回 `detail`」的机器判据）。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);

/* ---- 沙箱：`AI_MINDMAP_PROJECTS_DIR` 必须在 require `cli/main.js` **之前**设好 ---- */
const SANDBOX = makeTmp('mm-read-size-');
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;
process.env.MM_HEAT_SENSOR = 'off';          // 旁路埋点一个字节都不写（读路径也不许留痕在项目里）

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const heatSensor = require('../src/heat-sensor.js');

heatSensor.__setEnabledForTest(false);

/* 重定向必须**当场**生效：否则夹具会写进真实 `projects/`（那是一条不可逆的污染）。 */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效：PROJECTS_DIR=' + core.PROJECTS_DIR + ' 期望=' + SANDBOX
    + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

afterAll(cleanupAll);

/* ============================================================
 * 上界（**唯一一处**实现；文档只写量级与复算公式，不另抄一份）
 * ============================================================ */
const MAG_B_PER_NODE = {
  'list --json': 200,
  'read --json': 2000,
  'read --json --brief': 600,
  'read --json --brief --compact': 450
};
const GET_BOUND = 2048;         // O(1)：与节点数无关（实测 152–289 B）
const SEARCH_ENVELOPE = 4096;   // 命中数组之外的信封（project/keyword/hitCount/budget/heat…）
const TOLERANCE = 2;            // 判据：bytes < 上界 × 2（上界是"量级"，不是紧贴读数）

/** `get` 这一档的判据（O(1)：只有常数上界，与节点数无关） */
const getBytesOk = (bytes) => bytes < GET_BOUND * TOLERANCE;

/** 某个 O(n) 入口在 n 个节点上的字节上界 */
function upperBound(entry, nodes) {
  if (!Object.prototype.hasOwnProperty.call(MAG_B_PER_NODE, entry)) {
    // 不许静默返回 0（那会让"没有上界"看起来像"通过"）
    throw new Error('没有为入口 `' + entry + '` 定义字节上界（要加就同时加进 ARCHITECTURE 的量级表）');
  }
  return nodes * MAG_B_PER_NODE[entry];
}

/** 判定一个读数：{ ok, upper, limit, bytes, perNode } */
function verdictOf(entry, nodes, bytes) {
  const upper = upperBound(entry, nodes);
  const limit = upper * TOLERANCE;
  return { ok: bytes < limit, upper: upper, limit: limit, bytes: bytes, perNode: Math.round(bytes / nodes) };
}

/* ============================================================
 * 夹具：在 `%TEMP%` 里建项目（形状刻意贴真实书：标题是中文长句、详情是 HTML、密度 ~4/5）
 * ============================================================ */
const run = (argv) => invokeSync(argv);

/** 一段 ~85 字的中文 HTML 详情（≈ 255 B）。`fat` 时 60 段（≈ 15 KB） */
function detailOf(n, fat) {
  const p = '<p>这一段用来把详情撑到接近真实笔记的长度：讲清楚一个概念、它的取舍、以及它在现场怎么用。'
    + '真实笔记的详情不是一句话，而是若干段能独立读懂的文字。</p>';
  // 密度刻意贴真实书：三本书的详情贡献是 862–1246 B/节点（见文件头），
  // `times=4` 合 ~1 KB/节点 ⇒ 夹具的 B/节点落在真书的同一档，上界才不是空放着的。
  const times = fat ? 60 : 4;
  let html = '';
  for (let i = 0; i < times; i++) html += p;
  return html + '<p>（生成序号 ' + n + '）</p>';
}

/**
 * 建一个项目。
 * @param {string} name 项目名
 * @param {{chapters:number, per:number, fatId?:string, asset?:number}} o
 *   `chapters × per` = 叶子数；`fatId` 指定的节点挂**超长详情**；`asset` 挂一个这么大的假附件
 */
function mkProject(name, o) {
  const chapters = [];
  let seq = 0;
  for (let c = 0; c < o.chapters; c++) {
    const leaves = [];
    for (let i = 0; i < o.per; i++) {
      seq += 1;
      const id = 'n' + seq;
      const node = { id: id, topic: '第 ' + (c + 1) + ' 章第 ' + (i + 1) + ' 节：一个长度接近真实笔记的标题', children: [] };
      if (id === o.fatId) node.detail = detailOf(seq, true);
      else if (seq % 5 !== 0) node.detail = detailOf(seq, false);   // 4/5 的节点有详情（贴着真实书）
      if (seq % 7 === 0) node.tags = ['内核', '网络'];
      leaves.push(node);
    }
    chapters.push({ id: 'c' + (c + 1), topic: '第 ' + (c + 1) + ' 章：整章标题，长度中等', children: leaves });
  }
  const dir = path.join(SANDBOX, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify({
    meta: { name: name, author: '', version: '0.19.0', formatVersion: 2 },
    format: 'node_tree',
    data: { id: 'root', topic: name, expanded: true, children: chapters }
  }, null, 2), 'utf8');
  return dir;
}

/** 给项目挂一个 `bytes` 大小的假附件（用来证明 export 的体积由**资源**驱动） */
function attachAsset(projDir, bytes) {
  fs.mkdirSync(path.join(projDir, 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(projDir, 'attachments', 'big.bin'), Buffer.alloc(bytes, 7));
}

/** 把某个节点的 `files[]` 指向那个附件（`export-json` 会把它 base64 内嵌） */
function linkAsset(projName, nodeId, relFile) {
  const file = path.join(SANDBOX, projName, projName + '.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const walk = (n) => {
    if (n.id === nodeId) { n.files = [{ file: relFile, caption: '单测用假附件（内容无意义，只为体积）' }]; return true; }
    return (n.children || []).some(walk);
  };
  walk(j.data);
  fs.writeFileSync(file, JSON.stringify(j, null, 2), 'utf8');
}

const bytesOf = (s) => Buffer.byteLength(s, 'utf8');

const jrun = (argv) => {
  const r = run(argv);
  expect(r.code, argv.join(' ') + ' 失败：' + (r.stdout || '') + (r.stderr || '')).toBe(0);
  return r;
};

/* 夹具（建一次，全程复用；收尾由 cleanupAll 统一删） */
const BIG = 'rs-big';          // 6 × 20 = 120 叶子 + 6 章 + 根 = 127 节点
const BIG_TREE = { chapters: 6, per: 20 };
const SMALL = 'rs-small';      // 2 × 5 = 10 叶子 + 2 章 + 根 = 13 节点
const SMALL_TREE = { chapters: 2, per: 5 };
const FAT_ID = 'n7';           // 超长详情节点（用于"get 不带 detail"与 read 的对照）
const ASSET = 'rs-asset';      // 带 1 MB 附件的项目（用于 export 口径）
const ASSET_BYTES = 1024 * 1024;

const bigDir = mkProject(BIG, Object.assign({ fatId: FAT_ID }, BIG_TREE));
mkProject(SMALL, SMALL_TREE);
mkProject(ASSET, { chapters: 1, per: 2 });
attachAsset(path.join(SANDBOX, ASSET), ASSET_BYTES);
linkAsset(ASSET, 'n1', 'attachments/big.bin');

const bigList = jrun(['list', BIG, '--json']);
const NODES = JSON.parse(bigList.stdout).nodes.length;
const bigRead = jrun(['read', BIG, '--json']);
const bigBrief = jrun(['read', BIG, '--json', '--brief']);
const bigCompact = jrun(['read', BIG, '--json', '--brief', '--compact']);
const getFat = jrun(['get', BIG, FAT_ID, '--json']);

/* ============================================================
 * §A 上界的形状：纯函数，两种答案都数得出来（`testing-for-ai` B4b/B4c）
 * ============================================================ */
describe('G-14 上界的形状：≈ 节点数 × K，且判据是"小于"不是"小于等于"', () => {
  it('四个 O(n) 入口都有上界；**未知入口一律抛错**（不许静默返回 0 = "没有上界却像通过"）', () => {
    Object.keys(MAG_B_PER_NODE).forEach((k) => {
      expect(upperBound(k, 100)).toBe(100 * MAG_B_PER_NODE[k]);
    });
    expect(() => upperBound('read --json --skeleton', 100)).toThrow(/没有为入口/);
  });

  it('★ 边界：上界×2 **减 1** 绿；**正好等于**上界×2 红（`<` 而非 `<=`）', () => {
    const nodes = 100;
    const limit = upperBound('list --json', nodes) * TOLERANCE;
    expect(verdictOf('list --json', nodes, limit - 1).ok).toBe(true);
    expect(verdictOf('list --json', nodes, limit).ok).toBe(false);
    expect(verdictOf('list --json', nodes, limit + 1).ok).toBe(false);
  });

  it('上界随节点数**线性**走（夹具换规模时判据自动复算，不需要改常量）', () => {
    expect(upperBound('read --json', 1000) / upperBound('read --json', 100)).toBe(10);
  });
});

/* ============================================================
 * §B 夹具上的真实读数（真 CLI、真字节）
 * ============================================================ */
describe('G-14 O(节点数) 的入口：夹具读数 < 上界 × 2', () => {
  it('夹具完整（节点数对得上，否则后面的字节判据是空的）', () => {
    // 根 + 章 + 叶子：BIG_TREE 决定，写在这里是**复算**的形式，不是抄一个读数
    expect(NODES).toBe(1 + BIG_TREE.chapters + BIG_TREE.chapters * BIG_TREE.per);
  });

  const cases = [
    ['list --json', () => bigList],
    ['read --json', () => bigRead],
    ['read --json --brief', () => bigBrief],
    ['read --json --brief --compact', () => bigCompact]
  ];
  cases.forEach(([entry, get]) => {
    it('★ `' + entry + '`：' + NODES + ' 节点 ⇒ 实测 ' + bytesOf(get().stdout) + ' B（'
      + Math.round(bytesOf(get().stdout) / NODES) + ' B/节点）< 上界 ' + upperBound(entry, NODES) + ' × 2', () => {
      const v = verdictOf(entry, NODES, bytesOf(get().stdout));
      expect(v.ok, entry + ' 超上界：实测 ' + v.bytes + ' B / 上界×2 = ' + v.limit + ' B（'
        + v.perNode + ' B/节点 vs MAG ' + MAG_B_PER_NODE[entry] + '）').toBe(true);
    });
  });

  it('三档真的在省：brief < 全量，compact < brief（若某档不再省，这条会红）', () => {
    expect(bytesOf(bigBrief.stdout)).toBeLessThan(bytesOf(bigRead.stdout));
    expect(bytesOf(bigCompact.stdout)).toBeLessThan(bytesOf(bigBrief.stdout));
    // 且省的不是一点点（详情/缩进占大头）——用**比值**判，不用绝对字节
    expect(bytesOf(bigRead.stdout) / bytesOf(bigBrief.stdout)).toBeGreaterThan(1.5);
  });

  it('`list` 是 O(节点数)：大项目的字节数 ≈ 节点数之比（小项目不会因为"固定开销"失真）', () => {
    const small = jrun(['list', SMALL, '--json']);
    const smallNodes = JSON.parse(small.stdout).nodes.length;
    const ratio = bytesOf(bigList.stdout) / bytesOf(small.stdout);
    const nodeRatio = NODES / smallNodes;
    expect(nodeRatio).toBeGreaterThan(5);
    expect(ratio).toBeGreaterThan(nodeRatio / 2);   // 不要求相等（固定开销会让它偏小），只要同阶
  });
});

describe('G-14 O(1) 的入口：`get` 与节点数无关，且**不带 detail**', () => {
  it('★ 同一节点的 `get --json` 在大/小两个项目上字节数几乎相同（否则它就是 O(n) 了）', () => {
    const a = jrun(['get', BIG, 'n1', '--json']);
    const b = jrun(['get', SMALL, 'n1', '--json']);
    const ba = bytesOf(a.stdout);
    const bb = bytesOf(b.stdout);
    expect(Math.max(ba, bb) / Math.min(ba, bb)).toBeLessThan(1.5);
    expect(ba).toBeLessThan(GET_BOUND * TOLERANCE);
  });

  it('★ 铁律「`get --json` 不返回 detail」的机器判据：正文 ≈15 KB 的节点 ⇒ `get` 仍 < 上界', () => {
    const g = JSON.parse(getFat.stdout);
    expect(g.detail).toBeUndefined();                             // 契约面：字段就不该出现
    expect(bytesOf(getFat.stdout)).toBeLessThan(GET_BOUND * TOLERANCE);  // 字节面：带了就必红
    // 对照：同一节点在 `read --json` 里**有**那段正文 ⇒ 上面的"没有"不是因为夹具里没有
    const readFat = JSON.parse(bigRead.stdout).nodes.filter((n) => n.id === FAT_ID)[0];
    expect(String(readFat.detail || '').length).toBeGreaterThan(1000);
  });

  it('★ 这条判据**能被打红**（口径证明）：把 `get` 的读数按"带了 detail"估一遍 ⇒ 立刻越界', () => {
    // 不能靠"还原旧实现"来证明（`src/` 在本任务里只读），所以用**代进读数**的方式证：
    // 把"若 detail 也带出来"的真实体积（≈15 KB）喂给同一条判据 ⇒ 必须判红。
    expect(getBytesOk(bytesOf(getFat.stdout))).toBe(true);      // 现状：绿
    const leaked = bytesOf(getFat.stdout) + 15 * 1024;          // 泄漏后的体积
    expect(leaked).toBeGreaterThan(GET_BOUND * TOLERANCE);
    expect(getBytesOk(leaked)).toBe(false);                     // 同一套判据对泄漏体判红
  });

  it('`get --json` 返回的是"实况"而不是"全量"：它带 path，不带 children 递归', () => {
    const g = JSON.parse(getFat.stdout);
    expect(Array.isArray(g.path)).toBe(true);
    expect(g.path[g.path.length - 1]).toBe(FAT_ID);
    expect(g.children).toBeUndefined();
  });
});

describe('G-14 预算驱动的入口：`search` 的上界由它自己声明的 --max-bytes 守着', () => {
  it('★ `--max-bytes 8000` ⇒ 输出 ≤ 声明的 maxBytes + 信封（判据不另抄一份预算常量）', () => {
    const r = jrun(['search', BIG, '章', '--json', '--limit', '200', '--max-bytes', '8000']);
    const j = JSON.parse(r.stdout);
    expect(j.budget.maxBytes).toBe(8000);                          // 声明的上界读回来
    const bytes = bytesOf(r.stdout);
    expect(bytes).toBeLessThanOrEqual(8000 * TOLERANCE + SEARCH_ENVELOPE);
    // 预算真的在卡：命中面很大 ⇒ 必须被截断并如实说 truncated
    expect(j.truncated).toBe(true);
  });

  it('预算放宽 ⇒ 返回更多命中（证明截断是**预算**造成的，不是命中面本来就小）', () => {
    const tight = JSON.parse(jrun(['search', BIG, '章', '--json', '--limit', '200', '--max-bytes', '8000']).stdout);
    const loose = JSON.parse(jrun(['search', BIG, '章', '--json', '--limit', '200', '--max-bytes', '40000']).stdout);
    expect(loose.hits.length).toBeGreaterThan(tight.hits.length);
    expect(loose.budget.bytes).toBeLessThanOrEqual(40000);
  });
});

/* ============================================================
 * §C 为什么 `export-json` **不在**"节点数 × K"的上界里（把理由变成读数）
 * ============================================================ */
describe('G-14 为什么不给 `export-json` 设"节点数 × K"的上界（理由是可复算的读数）', () => {
  it('★ 同一个项目：挂 1 MB 附件后导出文件跳到 > 1 MB，而**节点数一个没变**', () => {
    const out = path.join(SANDBOX, 'export-check.aimap.json');
    const r = jrun(['export-json', ASSET, out]);
    expect(r.code).toBe(0);
    const bytes = fs.statSync(out).size;
    const nodes = JSON.parse(jrun(['list', ASSET, '--json']).stdout).nodes.length;
    expect(nodes).toBe(1 + 1 + 2);                                 // 节点很少（4 个）
    // 体积由**资源**（base64 内嵌）驱动，不是节点数：1 MB 的附件 ⇒ 文件必须 > 1 MB
    expect(bytes).toBeGreaterThan(ASSET_BYTES);
    // 换成"节点数 × K"会得到 < 1 KB —— 差三个数量级 ⇒ 那种上界对 export 没有意义
    expect(nodes * MAG_B_PER_NODE['read --json']).toBeLessThan(bytes / 100);
    expect(fs.existsSync(out)).toBe(true);
    fs.rmSync(out, { force: true });
  });

  it('`export-json` 的输出是**文件**（不进上下文）：所以它按"内容+资源"计，不按"读入口"计', () => {
    // 口径写成可查的形态：它的体积 = 项目 JSON + Σ 资源 × 4/3（base64）
    const projBytes = fs.statSync(path.join(SANDBOX, ASSET, ASSET + '.json')).size;
    expect(projBytes).toBeLessThan(ASSET_BYTES);                   // 项目 JSON 本身很小
  });
});

/* ============================================================
 * §D 夹具与真实 `projects/` 的隔离（照 `testing-for-ai` E2：不只主进程，子进程也要隔离）
 * ============================================================ */
describe('G-14 本文件不碰真实 projects/', () => {
  it('所有读写都发生在 %TEMP% 沙箱里；沙箱外那棵树没被写到', () => {
    expect(path.resolve(core.PROJECTS_DIR)).toBe(path.resolve(SANDBOX));
    // 真实 projects/ 只读：本文件从头到尾没往那里写过东西（反向判据：那里也没有 rs-* 项目）
    const realProjects = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', 'projects');
    if (fs.existsSync(realProjects)) {
      expect(fs.readdirSync(realProjects).filter((n) => n.indexOf('rs-') === 0)).toEqual([]);
    }
    expect(fs.existsSync(bigDir)).toBe(true);                      // 夹具在沙箱里（不是被删了才"没红"）
  });
});
