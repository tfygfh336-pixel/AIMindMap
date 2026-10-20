/* ============================================================
 * tests/g15-umd-dual.test.js —— G-15 下沉件的**双端**回归（2026-10-20）
 * ------------------------------------------------------------
 * 为什么需要这一条（它是下沉**引入**的风险，不是既有缺陷）：
 *   `src/` 是 UMD（Node + 浏览器双端）。下沉把 `validateProject` / `readHeatFile` 各劈成
 *   「纯核心 + IO 壳」两半 —— 纯核心一旦**不小心**引用了 `fs`，Node 侧的单测照样全绿
 *   （那里 fs 是真的），而浏览器侧会在**运行时**炸。`npm run verify` 的 smoke 也不一定走得到
 *   这几个函数 ⇒ 这条缝只能在这里钉。
 *
 * 判据（三条，各自可执行）：
 *   ① 浏览器端（无 `module` / 无 `require`，只有 `self`）能**加载**这两个文件，并拿到全局名；
 *   ② 浏览器端**纯核心能用**：喂对象 / 字符串就出结果，一次盘的读写都不该发生；
 *   ③ 浏览器端**IO 壳响亮抛错**（不是 `Cannot read properties of null` 那种漏形状）。
 * ⚠️ ⑤⑥ 是 2026-10-20「双端加载」批**翻面**过的断言。翻面前的原文钉着这样一条事实：
 *   `src/item-src.js` / `src/doc-import.js` 在浏览器端**加载即抛** `ReferenceError: require is not defined`
 *   （HEAD 版同样如此，不是 G-15 下沉造成的）—— 那时把它们当"Node-only，如实登记"钉住，
 *   免得将来有人把它读成"下沉弄坏了双端"。
 *   而 `src/` 的契约是 UMD 双端（`docs/ARCHITECTURE.md` §2.1/§8.4）⇒ 那不是"合规的 Node-only"，
 *   是**两个不合规的文件一直没人测**。翻面后这两条钉的是**修好之后**的状态：
 *   能加载、全局名在、Node 专属能力**函数在但调用即抛"需要 Node 环境"**（不是 ReferenceError，
 *   也不是 `Cannot read properties of null` 那种漏形状）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const srcPath = (f) => fileURLToPath(new URL('../src/' + f, import.meta.url));

/** 造一个"浏览器端"沙箱：只有 `self`，**没有** `module` / `exports` / `require` */
function browserSandbox(files) {
  const sandbox = { console: console };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  files.forEach((f) => vm.runInContext(fs.readFileSync(srcPath(f), 'utf8'), sandbox, { filename: f }));
  return sandbox;
}

describe('G-15 · UMD 双端：下沉出来的纯核心在浏览器端也能用', () => {
  it('① 浏览器端能加载 schema.js / heat.js，且三个下沉导出都在全局对象上', () => {
    const sb = browserSandbox(['assoc.js', 'item-model.js', 'relations.js', 'schema.js', 'heat.js']);
    expect(sb.MMSchema, 'MMSchema 全局名不见了（UMD 分支坏了）').toBeTruthy();
    expect(sb.MMHeat).toBeTruthy();
    // 下沉出来的三个名字必须**跟着导出**（少了就是"只在 Node 可用"）
    expect(typeof sb.MMSchema.validateInPlace).toBe('function');
    expect(typeof sb.MMSchema.validateCrossRefs).toBe('function');
    expect(typeof sb.MMSchema.makeProjectReader).toBe('function');
    expect(typeof sb.MMHeat.heatFromLogText).toBe('function');
  });

  it('② 浏览器端纯核心**能用**：validateInPlace 判字段、heatFromLogText 算读数（都不碰盘）', () => {
    const sb = browserSandbox(['assoc.js', 'item-model.js', 'relations.js', 'schema.js', 'heat.js']);
    const okData = { meta: { name: 'x' }, format: 'node_tree', data: { id: 'root', topic: 'R' } };
    expect(sb.MMSchema.validateInPlace(okData).ok).toBe(true);
    expect(sb.MMSchema.validateInPlace({ format: 'node_tree' }).errors).toContain('缺少 meta');
    // 注入式：浏览器端也能用"内存里的别的项目"跑跨项目判据（不需要 fs）
    const c = (proj) => (proj === 'Q' ? { ok: true, data: { data: { id: 'y', topic: 'Y' } } } : null);
    const pack = {
      meta: { name: 'P' }, format: 'node_tree',
      data: { id: 'root', topic: 'R', children: [{ id: 'a', topic: 'A', links: [{ project: 'Q', id: 'y' }] }] }
    };
    expect(sb.MMSchema.validateCrossRefs(pack, c, 'P').ok).toBe(true);
    // 空日志 ⇒ 0 事件（不抛、也不读盘）
    expect(sb.MMHeat.heatFromLogText('', { now: Date.now() }).events).toBe(0);
  });

  it('③ 浏览器端 IO 壳**响亮抛错**（不是 null 属性访问那种漏形状）', () => {
    const sb = browserSandbox(['assoc.js', 'item-model.js', 'relations.js', 'schema.js', 'heat.js']);
    expect(() => sb.MMSchema.makeProjectReader('D:/x')('y')).toThrow(/Node 环境/);
    expect(() => sb.MMHeat.readHeatFile('D:/x.jsonl')).toThrow(/Node 环境/);
  });

  it('④ `validateProject` 在浏览器端仍然**不因缺 fs 而崩**（跨项目档整段跳过，与拆分前一致）', () => {
    const sb = browserSandbox(['assoc.js', 'item-model.js', 'relations.js', 'schema.js', 'heat.js']);
    const pack = {
      meta: { name: 'P' }, format: 'node_tree',
      // 一条真"悬挂"的链接：浏览器侧判不出来（没盘可读）—— 与拆分前逐字节一致的口径
      data: { id: 'root', topic: 'R', children: [{ id: 'a', topic: 'A', links: [{ project: 'Q', id: 'ghost' }] }] }
    };
    expect(sb.MMSchema.validateProject(pack, 'D:/no-such-root', 'P').ok).toBe(true);
  });

  it('⑤ 边界如实：item-src / doc-import 在浏览器端**能加载**（修复前：两者加载即抛 require is not defined）', () => {
    // 【修复前的读数，留档】本条断言在 2026-10-20「双端加载」批之前是**反着写的**：
    //   ['item-src.js', 'doc-import.js'].forEach((f) => {
    //     expect(() => vm.runInContext(fs.readFileSync(srcPath(f), 'utf8'), sandbox), f)
    //       .toThrow(/require is not defined/);
    //   });
    // 即"钉住它们加载不了"这条现状。修的正是这件事 ⇒ 现在钉：① 能加载；② 全局名在。
    const sb = browserSandbox(['item-src.js', 'doc-import.js']);
    expect(sb.MMItemSrc, 'MMItemSrc 全局名不见了（UMD 头又坏了？）').toBeTruthy();
    expect(sb.MMDocImport, 'MMDocImport 全局名不见了（UMD 头又坏了？）').toBeTruthy();
    // 纯的那一半在浏览器端**真能用**（这两条不碰盘）
    expect(JSON.stringify(sb.MMItemSrc.VERDICTS)).toBe('["ok","needs-recheck","src-gone"]');
    expect(typeof sb.MMDocImport.textToOutline).toBe('function');
    expect(sb.MMDocImport.MAX_SOURCE_MB).toBe(64);
  });

  it('⑥ 浏览器端调 Node 专属能力 ⇒ 抛「需要 Node 环境」（不是 require is not defined、也不是 null 属性访问）', () => {
    // 与 ③ 同一条口径，只是对象换成"整份文件都要读盘"的那两个模块：
    // 它们在浏览器端**本来就该不可用**，合规做法是**显式守卫** —— 函数都在，调到就喊清楚。
    const sb = browserSandbox(['item-src.js', 'doc-import.js']);
    expect(() => sb.MMItemSrc.loadFile('/x')).toThrow(/需要 Node 环境/);
    expect(() => sb.MMItemSrc.resolveFile({ file: 'a.md' })).toThrow(/需要 Node 环境/);
    expect(() => sb.MMDocImport.docToOutline('D:/x.md')).toThrow(/需要 Node 环境/);
  });
});
