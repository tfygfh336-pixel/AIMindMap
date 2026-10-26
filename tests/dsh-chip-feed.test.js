/* ============================================================
 * tests/dsh-chip-feed.test.js — 「拖节点 ⇒ 真 chip」的客户端插件载荷（纯逻辑 + 载荷 + 装卸）
 * ------------------------------------------------------------
 * 为什么这些格子必须存在（本批最容易做假的三处）：
 *   ① 把"桩服务里插了个假 div"说成"chip 已实现" —— 所以这里**不给**任何"chip 已实现"的断言；
 *      真值（`InputState.occurrences`）只有真服务 + 真插件 + 真 session 才有，那一条**未验**。
 *      这里只钉能钉的：载荷形状、source 名不许编、失败必须**可见**（ok:false + reason）、
 *      以及"文本 ⇒ 单元"的判定两侧。
 *   ② 编一个 source 名 = 死 chip（提交时 serializeReference reject ⇒ 整条发送被拒）。
 *      ⇒ 有一条**扫描器**：载荷里出现任何字面量 source 名就红（并配一个变异体证明扫描器不是恒真）。
 *   ③ 装卸不可回滚 / 不可幂等 —— 所以 install 两次必须逐字节一致、bundles 不许重复、verify 能抓漂移。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const chip = require('../src/dsh-chip-feed.js');
const sc = require('../src/sidebar-context.js');

/** 载荷全文（扫描器与断言共用一处，别各抄一份） */
function payloadText() {
  const f = chip.files();
  return Object.keys(f).map((k) => f[k]).join('\n');
}

/** 扫描器：载荷里**字面量** source 名（`source: 'xxx'` / `source: "xxx"`）。空数组 = 只走常量 ✓ */
function literalSourceNames(text) {
  const out = [];
  const re = /source\s*:\s*(['"])([^'"]*)\1/g;
  let m;
  while ((m = re.exec(String(text))) !== null) out.push(m[2]);
  return out;
}

/** 造一个假的内核（只造本插件用到的那几个面：sessions / conversation.input / InputState）。 */
function fakeKernel(opts) {
  const o = opts || {};
  const calls = [];
  const seen = { draft: o.draft || '', draftRev: 7, occurrences: [] };
  const input = {
    state: { getSnapshot: () => ({ draft: seen.draft, draftRev: seen.draftRev, occurrences: seen.occurrences.slice() }) },
    actions: { captureInsertion: () => ({ start: 0, end: 0, draftRev: seen.draftRev }) },
    setDraft(v) {
      calls.push(['setDraft', v]);
      seen.draft = String(v);
      seen.occurrences = [];
      seen.draftRev += 1;
    },
    insertReference(ref, span) {
      calls.push(['insertReference', { source: ref.source, appearance: ref.appearance, ref: ref.ref, label: ref.label, clipboardText: ref.clipboardText }, span]);
      if (o.refuse === 'insertReference' || o.refuse === 'both') return false;
      if (o.wrongSource === true) {
        seen.occurrences.push({ source: 'made-up', appearance: 'file', ref: ref.ref, clipboardText: ref.clipboardText, label: ref.label });
        return true;
      }
      seen.occurrences.push({ source: 'reference', appearance: 'file', ref: ref.ref, clipboardText: ref.clipboardText, label: ref.label });
      seen.draft += ref.clipboardText + ' ';
      return true;
    },
    addFiles(refs, ids) {
      calls.push(['addFiles', refs.length, ids]);
      if (o.refuse === 'addFiles' || o.refuse === 'both') return false;
      for (const r of refs) seen.occurrences.push({ source: 'reference', appearance: 'file', ref: r.ref, clipboardText: r.clipboardText, label: r.label });
      return true;
    }
  };
  const actx = { agent: 's1' };
  const scope = {
    sessions: {
      list: { getSnapshot: () => ({ byId: { s2: { id: 's2', retainedBy: {} }, s1: { id: 's1', retainedBy: { mainView: 1 } } } }) },
      scope: (id) => (id === 's1' ? actx : undefined)
    },
    conversation: {
      input: {
        for: (a) => {
          calls.push(['for', a === actx ? 'actx' : 'not-actx']);
          if (a === undefined) throw new Error('conversation.input.for requires a retained Session scope');
          return input;
        }
      }
    }
  };
  return { scope, input, calls, seen };
}

/** 造一个假的插件 ctx（只造 `inject` 与 `effect` 两个动词）。 */
function fakeCtx(scope) {
  const disposers = [];
  const ctx = {
    inject(deps, cb) { ctx.injectedWith = deps.slice(); cb(scope); },
    effect(fn, label) {
      ctx.effectLabel = label;
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
      return d;
    },
    disposeAll() { for (const d of disposers.splice(0)) d(); }
  };
  return ctx;
}

/** 在假 window 里执行客户端 bundle（它必须自己向 `__ModuleLoader__.load` 注册）。 */
function loadClientBundle() {
  const regs = [];
  const win = { __ModuleLoader__: { load: (r) => regs.push(r) } };
  // eslint-disable-next-line no-new-func
  new Function('window', chip.CLIENT_JS)(win);
  const reg = regs[0];
  const mod = reg.factory(() => { throw new Error('this bundle requires no modules'); });
  return { reg, mod, count: regs.length };
}

describe('⑪ chip 单元：什么文案才配变成"一块"', () => {
  it('2 个节点 ⇒ 2 个单元，ref/clipboardText 与纯文本路径**逐字相同**，label 只取标题段', () => {
    const text = sc.buildSidebarText('comnet', [{ topic: '1. 计算机网络和因特网' }, { topic: '1.1 什么是因特网' }]);
    const r = chip.chipUnitsFromText(text);
    expect(r).not.toBeNull();
    expect(r.items.length).toBe(2);
    expect(r.items.map((i) => i.ref)).toEqual(text.split('\n'));
    expect(r.items.map((i) => i.clipboardText)).toEqual(text.split('\n'));
    expect(r.items[0].label).toBe('1. 计算机网络和因特网');
    expect(r.items[1].label).toBe('1.1 什么是因特网');
  });

  it('「把对话送进侧栏」那种散文文案 ⇒ **不成立**（null），必须走纯文本（这一格是红侧：混进来就是一片垃圾 chip）', () => {
    const prose = ['【来自 AI MindMap 的对话】', '节点：某节点', '我：你好', 'AI：在的', '（接着上面这段继续）'].join('\n');
    expect(chip.chipUnitsFromText(prose)).toBeNull();
  });

  it('单行带 `@` / 行首是触发符 / 没有 `/` / 空串 ⇒ 一律不成立（四个否决各一格，缺一格就等于放宽了形状）', () => {
    expect(chip.chipUnitsFromText('@comnet/甲')).toBeNull();
    expect(chip.chipUnitsFromText('/comnet/甲')).toBeNull();
    expect(chip.chipUnitsFromText('甲')).toBeNull();
    expect(chip.chipUnitsFromText('')).toBeNull();
    expect(chip.chipUnitsFromText('comnet/甲\n乙')).toBeNull();        // 只要有一行不成形状，整段就不走 chip
  });
});

describe('⑫ 载荷：只许用内置 source，且主机半边是"故意的空 apply"', () => {
  it('`SOURCE` 写死为 reference / appearance 写死为 file（**不许参数化** —— 参数化就等于给了编造 source 的口子）', () => {
    expect(chip.SOURCE).toBe('reference');
    expect(chip.APPEARANCE).toBe('file');
    expect(chip.CLIENT_JS).toContain("var SOURCE = 'reference';");
    expect(chip.CLIENT_JS).toContain("var APPEARANCE = 'file';");
  });

  it('包装配契约：`__ModuleLoader__.load({id})` 的 id **必须等于包名**（内核按包名找注册），并声明 dsh.client', () => {
    const pkg = JSON.parse(chip.PACKAGE_JSON);
    expect(pkg.name).toBe(chip.PLUGIN_NAME);
    expect(chip.CLIENT_JS).toContain("id: '" + chip.PLUGIN_NAME + "'");
    expect(pkg.exports['./client']).toBe('./lib/client.js');
    expect(pkg.dsh.client.platform).toBe('web');
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml');
    // 主机半边要能被 Loader 当成一个插件行（空 apply 也要 export 出来）
    expect(chip.HOST_INDEX_JS).toContain('export function apply()');
  });

  it('**死 chip 红线**：载荷里不许出现字面量 source 名（只许走 `SOURCE` 常量）—— 并附判别力证明', () => {
    const dirty = payloadText();
    expect(literalSourceNames(dirty)).toEqual([]);
    // 判别力：同一把扫描器，喂一个"编了 source 名"的变异载荷 ⇒ 必须抓到
    const mutant = chip.CLIENT_JS.replace('source: SOURCE', "source: 'aimm-made-up'");
    expect(mutant).not.toBe(chip.CLIENT_JS);              // 变异确实落地了
    expect(literalSourceNames(mutant)).toEqual(['aimm-made-up']);
  });
});

describe('⑬ 客户端半边：注册 ⇒ 装句柄 ⇒ 调内核（绿/红两侧）', () => {
  it('bundle 自注册一次、导出 apply+inject；apply 之后页面全局出现句柄（句柄在不在 = 插件在不在）', () => {
    const { reg, mod, count } = loadClientBundle();
    expect(count).toBe(1);
    expect(reg.id).toBe(chip.PLUGIN_NAME);
    expect(typeof mod.apply).toBe('function');
    expect(mod.inject).toEqual(['sessions', 'conversation']);
    const k = fakeKernel({});
    const ctx = fakeCtx(k.scope);
    try {
      mod.apply(ctx);
      expect(ctx.injectedWith).toEqual(['sessions', 'conversation']);
      expect(typeof globalThis[chip.HANDLE]).toBe('function');
      expect(globalThis[chip.READY]).toMatchObject({ v: 1, plugin: chip.PLUGIN_NAME });
    } finally { ctx.disposeAll(); delete globalThis[chip.HANDLE]; delete globalThis[chip.READY]; }
    // 卸载后句柄必须消失（否则"插件不在位"这件事就判不出来）
    expect(globalThis[chip.HANDLE]).toBeUndefined();
  });

  it('该绿：N 个单元 ⇒ 先 setDraft("") 再逐条 insertReference(source=reference)，回执 occurrences 与期望逐字一致', async () => {
    const { mod } = loadClientBundle();
    const text = sc.buildSidebarText('p-绿', [{ topic: '甲' }, { topic: '乙' }]);
    const units = chip.chipUnitsFromText(text);
    const k = fakeKernel({});
    const ctx = fakeCtx(k.scope);
    try {
      mod.apply(ctx);
      const raw = await globalThis[chip.HANDLE]({ v: 1, items: units.items });
      const judged = chip.judgeInsertResult(raw, units.items);
      expect(judged.ok).toBe(true);
      expect(judged.reason).toBeNull();
      // 顺序：先清稿，再插；插入的 source/appearance/ref 逐条钉死
      expect(k.calls[0]).toEqual(['for', 'actx']);
      expect(k.calls[1]).toEqual(['setDraft', '']);
      const inserts = k.calls.filter((c) => c[0] === 'insertReference');
      expect(inserts.length).toBe(2);
      expect(inserts.map((c) => c[1].source)).toEqual(['reference', 'reference']);
      expect(inserts.map((c) => c[1].appearance)).toEqual(['file', 'file']);
      expect(inserts.map((c) => c[1].ref)).toEqual(text.split('\n'));
      expect(raw.route).toBe('insertReference');
      expect(Array.isArray(raw.occurrences)).toBe(true);
      expect(raw.occurrences.length).toBe(2);
    } finally { ctx.disposeAll(); delete globalThis[chip.HANDLE]; delete globalThis[chip.READY]; }
  });

  it('该红①：内核不接受 insertReference（返回 false）⇒ **必须 ok:false + 有原因**，不许静默（主进程据此降级成文本）', async () => {
    const { mod } = loadClientBundle();
    const units = chip.chipUnitsFromText(sc.buildSidebarText('p-红', [{ topic: '甲' }]));
    const k = fakeKernel({ refuse: 'both' });
    const ctx = fakeCtx(k.scope);
    try {
      mod.apply(ctx);
      const raw = await globalThis[chip.HANDLE]({ v: 1, items: units.items });
      const judged = chip.judgeInsertResult(raw, units.items);
      expect(raw.ok).toBe(false);
      expect(judged.ok).toBe(false);
      expect(String(judged.reason || '')).toContain('两条插入路线都没被接受');
    } finally { ctx.disposeAll(); delete globalThis[chip.HANDLE]; delete globalThis[chip.READY]; }
  });

  it('该红②：插入成功但 occurrences 的 source 不是 reference ⇒ 判红（这就是"死 chip"在小尺度下的等价物）', async () => {
    const { mod } = loadClientBundle();
    const units = chip.chipUnitsFromText(sc.buildSidebarText('p-红2', [{ topic: '甲' }]));
    const k = fakeKernel({ wrongSource: true });
    const ctx = fakeCtx(k.scope);
    try {
      mod.apply(ctx);
      const raw = await globalThis[chip.HANDLE]({ v: 1, items: units.items });
      const judged = chip.judgeInsertResult(raw, units.items);
      expect(judged.ok).toBe(false);
      expect(String(judged.reason || '')).toContain('occurrences 与期望不符');
    } finally { ctx.disposeAll(); delete globalThis[chip.HANDLE]; delete globalThis[chip.READY]; }
  });

  it('没有主视图 session ⇒ ok:false + `no-main-session`（不许"看起来插了"）', async () => {
    const { mod } = loadClientBundle();
    const units = chip.chipUnitsFromText(sc.buildSidebarText('p', [{ topic: '甲' }]));
    const k = fakeKernel({});
    k.scope.sessions.list.getSnapshot = () => ({ byId: { s9: { id: 's9', retainedBy: {} } } });
    const ctx = fakeCtx(k.scope);
    try {
      mod.apply(ctx);
      const raw = await globalThis[chip.HANDLE]({ v: 1, items: units.items });
      expect(raw).toMatchObject({ ok: false, reason: 'no-main-session' });
    } finally { ctx.disposeAll(); delete globalThis[chip.HANDLE]; delete globalThis[chip.READY]; }
  });
});

describe('⑭ 装卸：幂等 + 可核对 + 可撤回（全在临时目录里做，不碰真实 dsh-home）', () => {
  function tempHome() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimm-chip-'));
    fs.mkdirSync(path.join(dir, 'profiles', 'web'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'profiles', 'web', 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true,
      dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-browser-plus'] } }
    }, null, 2) + '\n', 'utf8');
    return dir;
  }

  it('装两次 ⇒ 逐字节相同、bundles 不重复、第一次留下备份；verify 全绿', () => {
    const home = tempHome();
    try {
      const a = chip.install(home, { now: new Date('2026-10-26T00:00:00Z') });
      const first = fs.readFileSync(path.join(home, 'profiles', 'web', 'package.json'), 'utf8');
      const b = chip.install(home, { now: new Date('2026-10-26T00:01:00Z') });
      const second = fs.readFileSync(path.join(home, 'profiles', 'web', 'package.json'), 'utf8');
      expect(a.bundlesAfter.filter((n) => n === chip.PLUGIN_NAME).length).toBe(1);
      expect(a.backup).toBeTruthy();
      expect(fs.existsSync(a.backup)).toBe(true);              // 备份真的在盘上
      expect(b.backup).toBeNull();                             // 第二次不需要再备份
      expect(b.written).toEqual([]);                           // 第二次一个字节都不用写
      expect(second).toBe(first);
      const v = chip.verify(home);
      expect(v).toMatchObject({ installed: true, payloadOk: true, bundlesEntry: true, drift: [], missing: [] });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('载荷被改一个字节 ⇒ verify 判红（判据是**内容级**，不是"目录存在"）', () => {
    const home = tempHome();
    try {
      chip.install(home);
      expect(chip.verify(home).payloadOk).toBe(true);
      const f = path.join(chip.pluginDirOf(home), 'lib', 'client.js');
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + '\n// drift\n', 'utf8');
      const v = chip.verify(home);
      expect(v.payloadOk).toBe(false);
      expect(v.drift).toEqual(['lib/client.js']);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('撤回 ⇒ 插件目录 + bundles 那一项都没了（空 `@aimm` 容器也一起收掉），再 verify 是"没装"', () => {
    const home = tempHome();
    try {
      chip.install(home);
      const r = chip.uninstall(home);
      expect(r.bundlesAfter).toEqual(['@deepseek-ai/dsh-base', 'dsh-browser-plus']);
      expect(fs.existsSync(chip.pluginDirOf(home))).toBe(false);
      expect(fs.existsSync(path.join(home, 'profiles', 'web', 'node_modules', '@aimm'))).toBe(false);
      expect(chip.verify(home)).toMatchObject({ installed: false, bundlesEntry: false });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
