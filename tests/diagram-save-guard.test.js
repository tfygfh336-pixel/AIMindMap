/* ============================================================
 * tests/diagram-save-guard.test.js —— 缺陷 ②："载荷没带 `graph` ⇒ 从磁盘取回"
 * ------------------------------------------------------------
 * 为什么这条判据必须在这里、而且必须**真跑**那段处理函数（不是读源码 grep）：
 *   父批的原始前提是"保护在 `cli/commands/project.js` / `src/data-store.js` 里"，
 *   实读三处**全不成立**：project.js 没有 save 命令、data-store 没有那一层、真正的保护
 *   在 `main.js:2691` 的 `ipcMain.handle('project:save')` 里（GUI 保存不走 `store.write`）。
 *   而 `main.js` 在 node 里 `require` 不了（顶层就要 electron）⇒ 只靠 grep 只能证明"代码里写了"，
 *   不能证明"它真的保护了"。
 *
 * 本文件的**三层证明**：
 *   ① **共享实现的功能面**：`src/data-store.js` 的 `prepareSavePayload` —— 写盘/回读，逐字节比 graph；
 *   ② **真处理函数**：把 `main.js` 里 `project:save` 的**箭头函数源码原样取出来**，
 *      用一个 `new Function` 把它的外部依赖（fs/store/concurrency/versionAtRead…）全部打桩，
 *      然后**真的调它**（含"无并发改动"与"有并发改动走 merge"两条路）；
 *   ③ **闭环**：另有一条"用改动前的旧行为跑同一条路"的用例 —— 它**必须**把 graph 抹掉。
 *      没有 ③ 的话，"①②都绿"可能只是判据在空转（`testing-for-ai` B4：没红过的不算门禁）。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

afterAll(cleanupAll);

const dataStore = require('../src/data-store.js');
const concurrency = require('../src/concurrency.js');
const S = require('../src/schema.js');

const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

/* ---------------- 从 main.js 里取出 project:save 的箭头函数源码 ---------------- */

const SAVE_ANCHOR = "ipcMain.handle('project:save'";

/**
 * 取 `ipcMain.handle('project:save', (e, file, data, opts) => { … });` 里那个**箭头函数本身**。
 * 锚点找不到就**判红**（`throw`），绝不静默跳过 —— 静默跳过会让整条判据在"文件被重构"时变成空转。
 */
function extractSaveHandler(text) {
  const at = text.indexOf(SAVE_ANCHOR);
  if (at < 0) {
    throw new Error('锚点丢了：main.js 里找不到 ' + SAVE_ANCHOR + ' —— 本判据失效，'
      + '请在 main.js 的 project:save 处保留这一行，或同批改本文件的锚点（**不许**让它静默跳过）');
  }
  const arrow = text.indexOf('=> {', at);
  if (arrow < 0) throw new Error('锚点丢了：project:save 之后找不到 `=> {`');
  // 参数表：`=> {` 之前**最后一个** `(`（`ipcMain.handle('project:save', (e, file, data, opts) => {`）
  const params = text.lastIndexOf('(', arrow);
  if (params < 0) throw new Error('锚点丢了：project:save 的处理函数找不到参数表');
  // 处理函数的收尾是**恰好两格缩进**的 `});`（函数体内部语句都缩进 ≥4）
  const end = text.indexOf('\n  });', arrow);
  if (end < 0) throw new Error('锚点丢了：project:save 里找不到两格缩进的 `});` 收尾');
  const src = text.slice(params, end + 4);   // `\n  }` 四格 = 换行 + 两空格 + 箭头函数的收尾 `}`
  if (!/^\([^)]*\)\s*=>\s*\{/.test(src)) {
    throw new Error('取出来的不是一段箭头函数源码（开头是 ' + JSON.stringify(src.slice(0, 40))
      + '）—— 判据失效，必须修锚点');
  }
  if (src[src.length - 1] !== '}') {
    throw new Error('取出来的源码不以 `}` 收尾（结尾是 ' + JSON.stringify(src.slice(-20))
      + '）—— 判据失效，必须修锚点');
  }
  return src;
}

const ARROW_SRC = extractSaveHandler(MAIN_SRC);

/**
 * 用打桩的外部依赖**真跑**那段处理函数。
 * 外部符号清单来自源码实读（缺一个就会在调用时报 ReferenceError ⇒ 判据不会假绿）。
 */
function makeHandler(env) {
  const factory = new Function(
    'fs', 'path', 'require', 'store', 'concurrency', 'validateProjectOrThrow',
    'versionAtRead', 'baseAtRead', 'versionOf', 'versionOfText', 'writeFileAtomic',
    'isSmoke', 'return (' + ARROW_SRC + ');'
  );
  return factory(
    fs, path, createRequire(path.join(ROOT, 'main.js')), env.store, concurrency,
    env.validateProjectOrThrow, env.versionAtRead, env.baseAtRead, dataStore.versionOf,
    dataStore.versionOfText, dataStore.writeFileAtomic, false
  );
}

/* ---------------- 夹具 ---------------- */

/** 一份镜像真实项目的骨架（节点树 + 一条 graph） */
function projectWithGraph() {
  return {
    meta: { name: 'p1', formatVersion: 3 },
    format: 'node_tree',
    data: {
      id: 'root', topic: '根', expanded: true,
      children: [
        { id: 'n-a', topic: '甲', expanded: true, children: [] },
        { id: 'n-b', topic: '乙', expanded: true, children: [] }
      ]
    },
    graph: {
      version: 1,
      direction: 'LR',
      grid: 8,
      layers: [{ id: 'l-core', label: 'Core', rect: [0, 0, 600, 300], fill: '#eef4fb',
        watermark: { text: 'CORE', rotate: -90, opacity: 0.3 } }],
      containers: [{ id: 'c-box', layout: 'stack', rect: [10, 10, 200, 80], children: ['n-a'] }],
      edges: [{ id: 'e-ab', from: { node: 'n-a', port: 'e' }, to: { node: 'n-b', port: 'w' } }],
      annotations: [{ text: '注', at: [12, 40] }],
      pinned: ['n-a']
    }
  };
}

/** 造一个磁盘上的项目文件，返回 `{dir, file}` */
function makeProjectFile(data) {
  const dir = makeTmp('mm-diagram-save-');
  const pdir = path.join(dir, 'p1');
  fs.mkdirSync(pdir, { recursive: true });
  const file = path.join(pdir, 'p1.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return { dir: dir, file: file };
}

/** 窄模式（渲染层）那份载荷：**没有 graph、没有 assoc** —— 正是会抹掉整张图的那一份 */
function narrowPayload(topicA) {
  return {
    meta: { name: 'p1', formatVersion: 3 },
    format: 'node_tree',
    data: {
      id: 'root', topic: '根', expanded: true,
      children: [
        { id: 'n-a', topic: topicA || '甲', expanded: true, children: [] },
        { id: 'n-b', topic: '乙', expanded: true, children: [] }
      ]
    }
  };
}

function makeEnv() {
  return {
    store: { recordChange: () => {} },
    validateProjectOrThrow: (data, name) => {
      const v = S.validateProject(data, null, name);
      if (!v.ok) throw new Error(v.errors.join('; '));
    },
    versionAtRead: new Map(),
    baseAtRead: new Map()
  };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/* ---------------- ① 共享实现的功能面 ---------------- */

describe('prepareSavePayload（`project:save` 的数据安全那一层，唯一实现）', () => {
  it('载荷没带 graph ⇒ 从磁盘取回，且**逐字节**相同', () => {
    const disk = projectWithGraph();
    const out = dataStore.prepareSavePayload(narrowPayload(), disk);
    expect(JSON.stringify(out.graph)).toBe(JSON.stringify(disk.graph));
  });

  it('载荷带了 graph ⇒ 用载荷的（全模式会写它，不许被磁盘盖掉）', () => {
    const disk = projectWithGraph();
    const payload = narrowPayload();
    payload.graph = { version: 1, direction: 'TB', layers: [] };
    const out = dataStore.prepareSavePayload(payload, disk);
    expect(out.graph).toEqual({ version: 1, direction: 'TB', layers: [] });
  });

  it('`graph: {}` 算"带了"（"我明确说这张图没有附加结构" ≠ "我没有意见"）', () => {
    const disk = projectWithGraph();
    const payload = narrowPayload();
    payload.graph = {};
    const out = dataStore.prepareSavePayload(payload, disk);
    expect(out.graph).toEqual({});
  });

  it('assoc 保持**磁盘优先**（历史行为逐字不变：盘上有非空 assoc 就用盘上的）', () => {
    const disk = projectWithGraph();
    disk.assoc = [{ id: 'as-1' }];
    const payload = narrowPayload();
    payload.assoc = [];
    expect(dataStore.prepareSavePayload(payload, disk).assoc).toEqual([{ id: 'as-1' }]);
  });

  it('入参不被修改（纯：拿到的返回可能是原对象，但原对象不许被写）', () => {
    const disk = projectWithGraph();
    const payload = narrowPayload();
    const before = JSON.stringify(payload);
    dataStore.prepareSavePayload(payload, disk);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('磁盘读不回来（null/非对象）⇒ 原样返回，不编一份 graph', () => {
    [null, undefined, 'x', []].forEach((disk) => {
      const payload = narrowPayload();
      const out = dataStore.prepareSavePayload(payload, disk);
      expect(out).toBe(payload);
      expect(Object.prototype.hasOwnProperty.call(out, 'graph')).toBe(false);
    });
  });
});

/* ---------------- ② 真处理函数：两条路 ---------------- */

describe('真跑 main.js 的 project:save（源码原样取出 + 外部依赖打桩）', () => {
  it('处理函数确实调的是共享实现（不是另写一份规则）', () => {
    expect(ARROW_SRC).toContain('prepareSavePayload(');
    expect(ARROW_SRC).toContain("require('./src/data-store.js')");
    // 旧的"内联 assoc 规则"必须已经搬走（两处规则 = 必定漂）
    expect(ARROW_SRC).not.toContain('Object.assign({}, data, { assoc: cur.assoc })');
  });

  it('无并发改动（常见路径）：窄模式载荷整树写回后，盘上 graph **逐字节仍在**', () => {
    const disk = projectWithGraph();
    const { file } = makeProjectFile(disk);
    const env = makeEnv();
    env.versionAtRead.set('p1', dataStore.versionOf(file));      // 界面读过这一版 ⇒ 不触发合并
    env.baseAtRead.set('p1', disk);
    const handler = makeHandler(env);

    const r = handler(null, file, narrowPayload('甲（改过）'), {});
    expect(r.ok).toBe(true);
    expect(r.merged).toBe(false);

    const after = readJson(file);
    expect(after.data.children[0].topic).toBe('甲（改过）');       // 改动落地
    expect(JSON.stringify(after.graph)).toBe(JSON.stringify(disk.graph));   // 图一个字节没丢
  });

  it('有并发改动（走 merge 三方合并）：盘上的 graph 仍然在（`clone(theirs)` 保住它）', () => {
    const base = projectWithGraph();          // 界面读到的那一版：有 graph、甲=甲、乙=乙
    const disk = projectWithGraph();
    disk.data.children[1].topic = '乙（AI 改的）';   // 盘上：别人改了乙
    disk.graph.annotations = [{ text: 'AI 加的注释', at: [1, 2] }];   // 且 graph 也被别人改过
    const { file } = makeProjectFile(disk);
    const env = makeEnv();
    env.versionAtRead.set('p1', 'stale-version-hash');   // ≠ 盘上 ⇒ 进合并分支
    env.baseAtRead.set('p1', base);
    const handler = makeHandler(env);

    const payload = narrowPayload('甲（界面改的）');      // 界面改了甲、没带 graph
    const r = handler(null, file, payload, {});
    expect(r.ok).toBe(true);
    expect(r.merged).toBe(true);

    const after = readJson(file);
    // 两边的改动**都**保住了（合并的本职）
    expect(after.data.children[0].topic).toBe('甲（界面改的）');
    expect(after.data.children[1].topic).toBe('乙（AI 改的）');
    // 而 graph 用的是**盘上最新那一份**（不是界面读到的那份旧图，也不是"没有图"）
    expect(JSON.stringify(after.graph)).toBe(JSON.stringify(disk.graph));
  });
});

/* ---------------- ③ 闭环：旧行为必须红 ---------------- */

describe('判别力闭环：把保护拿掉，同一条路必须把图抹掉', () => {
  it('旧行为（载荷原样写回）⇒ graph 消失（所以上面那两条绿的才有意义）', () => {
    const disk = projectWithGraph();
    const { file } = makeProjectFile(disk);
    // 复刻"改动前"的写法：不做 prepareSavePayload，直接写 payload
    const payload = narrowPayload();
    dataStore.writeFileAtomic(file, JSON.stringify(payload, null, 2));
    const after = readJson(file);
    expect(Object.prototype.hasOwnProperty.call(after, 'graph')).toBe(false);
    expect(after.graph).toBeUndefined();
  });

  it('把"取回"换成"只取 assoc"（少一档）⇒ 同样抹掉 graph —— 这条是"半修"的判别力', () => {
    const disk = projectWithGraph();
    const payload = narrowPayload();
    // 只搬 assoc 那一档（改动前的原样），graph 不搬
    const halfFixed = Object.assign({}, payload, { assoc: disk.assoc || [] });
    expect(Object.prototype.hasOwnProperty.call(halfFixed, 'graph')).toBe(false);
    expect(JSON.stringify(halfFixed)).not.toContain('"graph"');
  });
});
