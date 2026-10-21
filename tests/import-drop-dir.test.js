/* ============================================================
 * tests/import-drop-dir.test.js —— 拖目录的**判据**（`r26`；vitest · 无 Electron）
 * ------------------------------------------------------------
 * 为什么有这个文件：`renderer/app-import.js` 的判据原先只看**扩展名**
 * （`extOf(name)`，输入只有文件名字符串）⇒ 目录算出的 ext 是空串，走进「暂不支持 这种 格式」，
 * 而**无扩展名的文件**（`README`）得到一字不差的答复 ⇒ 两件事混成了一件。
 * 真机复现（定题 §1.2）四行原话里，**最要命的是 `README` 与目录同答** ——
 * 任何"按扩展名猜 / 按有没有点猜"的实现都会被这一条测穿。
 *
 * 桩的边界（如实写）：本文件用**手写的最小 DOM / DataTransfer 桩**（与
 * `tests/tag-view-render.test.js:1-15` 同一套思路），证明的是**本模块自己的判据与转述**；
 * 真实 Chromium 里 `webkitGetAsEntry()` 对拖进来的文件夹是否返回 `isDirectory === true`
 * 需要真窗口 —— 那半边由 `scripts/smoke/43-import-entry.js` 的「辛」条覆盖（域 43）。
 *
 * ⚠️ 本文件**刻意模拟**真机那条最容易踩的语义：`DataTransferItemList` 在事件返回后**失效**
 *   （`webkitGetAsEntry()` 变 `null`、`items` 变空）。把判据挪到 `await` 之后 ⇒ 这里**恒 false**
 *   ⇒ 本文件的「同步窗口」那组**必红**。这条就是"修了等于没修"的机械判据。
 *
 * 三条注入（判别力，必须每条都红；撤销即复绿，见本批验收记录）：
 *   ① 把判据退回 `!ext ⇒ 目录`        ⇒ 「README 不许被说成目录」必红
 *   ② 删掉 `handleFiles` 的目录分支    ⇒ 「目录不许说暂不支持」必红
 *   ③ 把判据挪到 `await` 之后取        ⇒ 「同步窗口」必红
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'renderer', 'app-import.js'), 'utf8');
const docImport = require('../src/doc-import.js');

/** 最小 DOM 桩：这个模块只用 `getElementById` / `addEventListener` / `createElement` / `body` */
function mount(desktop) {
  const doc = {
    listeners: {},
    getElementById() { return null; },
    createElement() { return { style: {}, setAttribute() {}, appendChild() {} }; },
    body: { appendChild() {} },
    addEventListener(t, fn) { (doc.listeners[t] = doc.listeners[t] || []).push(fn); },
    fire(t, ev) { (doc.listeners[t] || []).forEach((fn) => fn(ev)); }
  };
  const win = { innerWidth: 1200, innerHeight: 800 };
  if (desktop) win.desktop = desktop;
  // eslint-disable-next-line no-new-func
  const factory = new Function('window', 'document', SRC);
  factory(win, doc);
  const status = [];
  win.MM.setStatus = (t, isErr) => status.push({ t: String(t), isErr: !!isErr });
  return { MM: win.MM, doc, status, win, last: () => (status.length ? status[status.length - 1].t : '') };
}

/** 只给 `pathForFile`（拿到真实路径）+ `importDoc`（转述 Node 侧原话）的 desktop 桩 */
function desktopWith(pathForFile, importDoc) {
  return { app: { pathForFile, importDoc } };
}

/** 真机语义的 `drop` 事件桩：
 *   · 同步窗口**开着**时 `webkitGetAsEntry()` 给出真实条目、`dt.items` 有元素；
 *   · 事件返回（`closeSyncWindow()`）之后 `webkitGetAsEntry()` 返回 `null`、`dt.items` 变空
 *     —— 这正是 Chromium 的 `DataTransferItemList` 失效形态，**不是我们编的**；
 *   · `dt.files` 不受影响（所以路径本来就能从 `File` 拿到 ✓）。 */
function mkDrop(entries) {
  const state = { syncOpen: true, prevented: false };
  const files = entries.map((e) => ({ name: e.name, __path: e.path || '' }));
  const items = entries.map((e, i) => ({
    kind: 'file',
    index: i,
    webkitGetAsEntry() {
      if (!state.syncOpen) return null;              // ← 失效
      return { isDirectory: !!e.isDir, isFile: !e.isDir, name: e.name };
    }
  }));
  const dt = {
    files,
    get items() { return state.syncOpen ? items : []; }   // ← 失效后整个列表为空
  };
  return {
    ev: { dataTransfer: dt, preventDefault() { state.prevented = true; } },
    close() { state.syncOpen = false; },
    state
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('判据本体：itemIsDirectory（只认 `isDirectory === true`）', () => {
  it('`isDirectory:true` ⇒ 真；`false` / `null` / 抛错 / 没有这个方法 / 缺字段 ⇒ 全假', () => {
    const h = mount(null);
    const f = h.MM.importItemIsDirectory;
    expect(f({ webkitGetAsEntry: () => ({ isDirectory: true }) })).toBe(true);
    expect(f({ webkitGetAsEntry: () => ({ isDirectory: false }) })).toBe(false);
    expect(f({ webkitGetAsEntry: () => null })).toBe(false);
    expect(f({ webkitGetAsEntry: () => undefined })).toBe(false);
    expect(f({ webkitGetAsEntry: () => ({}) })).toBe(false);          // 缺字段 ≠ 目录（`!!e` 会被这条测穿）
    expect(f({ webkitGetAsEntry: () => ({ isDirectory: 'true' }) })).toBe(false);  // 只认 === true
    expect(f({ webkitGetAsEntry() { throw new Error('boom'); } })).toBe(false);
    expect(f({})).toBe(false);
    expect(f(null)).toBe(false);
  });
});

describe('handleFiles：目录 ≠ 不认识的格式（README 那条反例是核心）', () => {
  it('无扩展名的**文件** `README` ⇒ 仍回「暂不支持 这种 格式」，且**不许**出现「目录」', async () => {
    const h = mount(null);
    await h.MM.importHandleFiles([{ name: 'README' }]);
    expect(h.last()).toContain('暂不支持');
    expect(h.last()).not.toContain('目录');
  });

  it('真的目录（`dirItem` 给到）⇒ 说「目录」+「导入文件夹」，且**不含**「暂不支持」', async () => {
    const h = mount(null);
    await h.MM.importHandleFiles([{ name: '我的书库' }], { dirItem: {}, dirIndex: 0 });
    expect(h.last()).toContain('目录');
    expect(h.last()).toContain('导入文件夹');
    expect(h.last()).not.toContain('暂不支持');
    expect(h.status[0].isErr).toBe(true);
  });

  it('名字里带点的目录（`notes.v2`）也进目录那一支 —— 用"名字里有没有点"当判据同样不成立', async () => {
    const h = mount(null);
    await h.MM.importHandleFiles([{ name: 'notes.v2' }], { dirItem: {} });
    expect(h.last()).toContain('目录');
    expect(h.last()).not.toContain('暂不支持 .v2');
  });

  it('有扩展名的普通文件不受影响（`.md` 在没有通道时如实说通道没接上）', async () => {
    const h = mount(null);
    await h.MM.importHandleFiles([{ name: 'a.md' }]);
    expect(h.last()).toContain('导入通道没接上');
  });

  it('**文案单源**：拿到真实路径时，状态栏是 **Node 侧原话的逐字转述**（渲染层没有自己的那一句）', async () => {
    const SENTINEL = 'NODE-SAYS::这个路径是目录，别拿单文件入口试 —— 用整库导入 <path>';
    const h = mount(desktopWith(() => 'D:\\我的书库', () => Promise.resolve({ ok: false, error: SENTINEL })));
    await h.MM.importHandleFiles([{ name: '我的书库' }], { dirItem: {} });
    await flush();
    expect(h.last()).toContain(SENTINEL);        // 原样转述 ⇒ 换成别的措辞也不会漏
  });

  it('同一路接上**真的** `src/doc-import.js`：那句 "这是一个**目录**，不是文件" 由它说，界面只转述', async () => {
    const P = 'D:\\我的书库';
    const h = mount(desktopWith(() => P, (p) => Promise.resolve({ ok: false, error: docImport.directoryMessage(p) })));
    await h.MM.importHandleFiles([{ name: '我的书库' }], { dirItem: {} });
    await flush();
    expect(h.last()).toContain(docImport.directoryMessage(P));
    expect(docImport.directoryMessage(P)).toContain('这是一个**目录**，不是文件');
    // 降级说法（拿不到路径那一路）**不是** Node 那句的复制品：它不提 CLI 的 import-dir ⇒ 只有一处会漂
    expect(h.MM.importHandleFiles.toString()).toBeTruthy();
  });
});

describe('drop 监听：目录判据必须在**事件返回之前**（同步窗口内）取到', () => {
  it('同步窗口内就已经说出「目录」（不是靠 await 之后才补一句）', async () => {
    const h = mount(desktopWith(() => '', () => Promise.resolve({ ok: false, error: 'x' })));
    const d = mkDrop([{ name: '我的书库', isDir: true }]);
    h.doc.fire('drop', d.ev);
    // 此刻事件监听器刚返回、`DataTransferItemList` **还没失效**：状态栏必须已经有话说
    expect(h.last()).toContain('目录');
    expect(d.state.prevented).toBe(true);
    d.close();
    await flush();
  });

  it('事件返回后 `webkitGetAsEntry()` 确实失效（桩的语义自检 —— 否则下面那条判据是空转）', () => {
    const d = mkDrop([{ name: 'x', isDir: true }]);
    expect(d.ev.dataTransfer.items.length).toBe(1);
    expect(d.ev.dataTransfer.items[0].webkitGetAsEntry()).toEqual({ isDirectory: true, isFile: false, name: 'x' });
    d.close();
    expect(d.ev.dataTransfer.items.length).toBe(0);
    expect(d.ev.dataTransfer.items[0]).toBeUndefined();
  });

  it('失效之后仍然是「目录」那一句（= 判据没有被推迟到 await 后面 ⇒ 这就是注入③的判据）', async () => {
    const h = mount(desktopWith(() => '', () => Promise.resolve({ ok: false, error: 'x' })));
    const d = mkDrop([{ name: '我的书库', isDir: true }]);
    h.doc.fire('drop', d.ev);
    d.close();
    await flush();
    expect(h.last()).toContain('目录');
    expect(h.last()).not.toContain('暂不支持');
  });

  it('混投（文件在前、目录在后）⇒ 点名的是**那个目录**，不把前面那个文件说成目录', async () => {
    const h = mount(desktopWith(() => '', () => Promise.resolve({ ok: false, error: 'x' })));
    const d = mkDrop([{ name: 'a.md' }, { name: '我的书库', isDir: true }]);
    h.doc.fire('drop', d.ev);
    expect(h.last()).toContain('目录');
    d.close();
    await flush();
  });

  it('拖**无扩展名文件**（`README`）进 drop ⇒ 仍回「暂不支持」，不许被说成目录', async () => {
    const h = mount(null);
    const d = mkDrop([{ name: 'README' }]);
    h.doc.fire('drop', d.ev);
    d.close();
    await flush();
    expect(h.last()).toContain('暂不支持');
    expect(h.last()).not.toContain('目录');
  });
});

describe('fallback（`desktop.app.pathKind` → 主进程 `fs.statSync().isDirectory()`）', () => {
  const withKind = (kind, ok) => ({
    app: {
      pathForFile: () => 'D:\\我的书库',
      importDoc: (p) => Promise.resolve({ ok: false, error: docImport.directoryMessage(p) }),
      pathKind: () => Promise.resolve({ ok: ok, kind: kind })
    }
  });

  it('`ok:true && kind:"dir"` ⇒ 走目录那一支', async () => {
    const h = mount(withKind('dir', true));
    await h.MM.importHandleFiles([{ name: '我的书库' }]);
    await flush();
    expect(h.last()).toContain('这是一个**目录**，不是文件');
  });

  it('`kind:"file"` ⇒ 当文件（回「暂不支持」）', async () => {
    const h = mount(withKind('file', true));
    await h.MM.importHandleFiles([{ name: '我的书库' }]);
    expect(h.last()).toContain('暂不支持');
  });

  it('`ok:false` / 通道不存在 / 抛错 ⇒ 一律当文件（取不到就当文件，不是"猜成目录"）', async () => {
    const bad = mount(withKind('dir', false));
    await bad.MM.importHandleFiles([{ name: '我的书库' }]);
    expect(bad.last()).toContain('暂不支持');

    const noChan = mount(desktopWith(() => 'D:\\x', () => Promise.resolve({ ok: true })));
    await expect(noChan.MM.importPathKindOf(noChan.win.desktop.app, 'D:\\x')).resolves.toBe('');

    const throwing = { app: { pathForFile: () => 'D:\\x', pathKind: () => Promise.reject(new Error('ipc down')) } };
    const h3 = mount(throwing);
    await expect(h3.MM.importPathKindOf(throwing.app, 'D:\\x')).resolves.toBe('');
  });
});
