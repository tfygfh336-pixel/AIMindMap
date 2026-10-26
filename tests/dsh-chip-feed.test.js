/* ============================================================
 * tests/dsh-chip-feed.test.js — 「拖节点 ⇒ 真 chip」的客户端插件载荷（纯逻辑 + 载荷 + 装卸）
 * ------------------------------------------------------------
 * 为什么这些格子必须存在（本批最容易做假的三处）：
 *   ① 把"桩服务里插了个假 div"说成"chip 已实现" —— 所以这里**不给**任何"chip 已实现"的断言；
 *      真值（`InputState.occurrences`）只有真服务 + 真插件 + 真 session 才有，那一条**未验**。
 *   这里只钉能钉的：载荷形状、source 名不许编、失败必须**可见**（ok:false + reason）、
 *   以及"文本 ⇒ 单元"的判定两侧。
 *   ② 编一个 source 名 = 死 chip（提交时 serializeReference reject ⇒ 整条发送被拒）。
 *      ⇒ 有一条**扫描器**：载荷里出现任何字面量 source 名就红（并配一个变异体证明扫描器不是恒真）。
 *   ③ 装卸不可回滚 / 不可幂等 —— 所以 install 两次必须逐字节一致、bundles 不许重复、verify 能抓漂移。
 *
 * ── 2026-10-42 本批主线（**追加 + seq 去重**）：这一屏的 ⑮⑯ 两节是本批的判据本体 ──────────
 *   用户真机（逐字）：「是块了，但是我先拉了两个过去，然后又选了两个过去，就会覆盖掉第一次的两个」
 *   ⇒ ① 两批（不同 seq）**累计** 4 个块（不是第二批把第一批顶掉）；
 *     ② 同一 seq 投两次 ⇒ 仍然 4 个（不是 6 个）—— 幂等**靠 seq**，不靠"清空草稿"；
 *     ③ 把 `setDraft("")` 加回去（源码级变异）⇒ 判据**必须红**（那一格是本批的"不许做假"）。
 *   ⚠️ 假内核按**真内核语义**建模（`insertFileReferences` 在选区末尾追加、chip 后补空格、
 *      occurrences 按 offset 排序、`insertReference` 只做 rev CAS）—— 因为判据要判的正是
 *      "块是不是接在末尾"，假内核不按这个建模，判据就成了自证。真机形态**仍未验**。
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

/** 只留**代码行**（注释里写"上一版靠 setDraft 清空"是**要留着**的病因说明）。 */
function codeOnly(text) {
  return String(text).split('\n')
    .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
    .join('\n');
}

/**
 * 造一个假的**内核**（只造本插件用到的那几个面），并按真内核语义建模：
 *   · `addFiles(refs, [])` → `insertFileReferences`：在**当前光标**批量追加 chip + 空格，
 *     光标前不是空白就先补一个空格（vendor 第 13331-13345 行）；
 *   · `insertReference(ref, span)` → `$replaceDetectSpanWithNodes(span, …)`：把 span 换成 chip，
 *     只做 `draftRev` CAS（vendor 第 13747 行）⇒ 我们给的**末尾 span** 就是追加；
 *   · `occurrences` 按 clipboard 坐标排序（`Occurrence.offset` 契约）；
 *   · `InputState.draft` = clipboard 投影（chip 展开成 clipboardText + 一个空格）。
 */
function fakeKernel(opts) {
  const o = opts || {};
  const calls = [];
  let occSeq = 0;
  const seen = { draft: o.draft || '', draftRev: 7, occurrences: [], caret: null, focused: 0 };
  seen.caret = seen.draft.length;

  function shiftFrom(at, delta) {
    for (const oc of seen.occurrences) if (oc.offset >= at) oc.offset += delta;
  }
  function pushChip(ref, at) {
    const text = String(ref.clipboardText);
    const src = (o.wrongSource === true) ? 'made-up' : ref.source;
    seen.draft = seen.draft.slice(0, at) + text + ' ' + seen.draft.slice(at);
    shiftFrom(at, text.length + 1);
    seen.occurrences.push({
      occurrenceId: ++occSeq, source: src, ref: ref.ref, label: ref.label,
      appearance: ref.appearance, clipboardText: ref.clipboardText,
      offset: at, length: text.length
    });
    seen.occurrences.sort((a, b) => a.offset - b.offset);
    seen.caret = at + text.length + 1;
    seen.draftRev += 1;                    // 真内核每次编辑都推进 rev（span CAS 用）
  }
  function pushBatch(refs, at0) {
    let at = at0;
    /* 光标前不是空白 ⇒ 内核先补一个空格（vendor 第 13339 行） */
    if (at > 0 && !/\s$/.test(seen.draft.slice(0, at))) {
      seen.draft = seen.draft.slice(0, at) + ' ' + seen.draft.slice(at);
      shiftFrom(at, 1);
      seen.caret = at + 1;
      at += 1;
    }
    for (const r of refs) { pushChip(r, at); at = seen.caret; }
  }

  const input = {
    state: {
      getSnapshot: () => ({
        draft: seen.draft, draftRev: seen.draftRev, phase: 'plain',
        occurrences: seen.occurrences.map((x) => Object.assign({}, x))
      })
    },
    actions: { captureInsertion: () => ({ start: seen.caret, end: seen.caret, draftRev: seen.draftRev }) },
    focus() { calls.push(['focus']); seen.focused += 1; },
    setDraft(v) {
      calls.push(['setDraft', v]);
      seen.draft = String(v);
      seen.occurrences = [];
      seen.caret = seen.draft.length;
      seen.draftRev += 1;
    },
    insertReference(ref, span) {
      calls.push(['insertReference', { source: ref.source, appearance: ref.appearance, ref: ref.ref,
        label: ref.label, clipboardText: ref.clipboardText }, span]);
      if (o.refuse === 'insertReference' || o.refuse === 'both') return false;
      if (span.draftRev !== seen.draftRev) return false;      // 真内核：先 rev CAS
      pushChip(ref, span.start);
      return true;
    },
    addFiles(refs, ids) {
      calls.push(['addFiles', refs.length, ids]);
      if (o.refuse === 'addFiles' || o.refuse === 'both') return false;
      pushBatch(refs, seen.caret == null ? seen.draft.length : seen.caret);
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

/** 在假 window 里执行客户端 bundle（它必须自己向 `__ModuleLoader__.load` 注册）。
 *  `jsSource` 允许传**变异体**（判据的判别力就靠它）。 */
function loadClientBundle(jsSource) {
  const regs = [];
  const win = { __ModuleLoader__: { load: (r) => regs.push(r) } };
  // eslint-disable-next-line no-new-func
  new Function('window', jsSource || chip.CLIENT_JS)(win);
  const reg = regs[0];
  const mod = reg.factory(() => { throw new Error('this bundle requires no modules'); });
  return { reg, mod, count: regs.length };
}

/** 装一个独立的插件实例 + 假内核，跑完自动卸载（每个格子互不污染 seq 集合）。 */
async function withPlugin(opts, fn) {
  const { mod } = loadClientBundle(opts && opts.jsSource);
  const k = fakeKernel(opts || {});
  const ctx = fakeCtx(k.scope);
  mod.apply(ctx);
  try {
    return await fn({ k, handle: globalThis[chip.HANDLE], mod });
  } finally {
    ctx.disposeAll();
    delete globalThis[chip.HANDLE];
    delete globalThis[chip.READY];
  }
}

/** 一次投喂：`{v, seq, items}` —— seq 必填（幂等的依据）。 */
function feed(handle, text, seq) {
  const units = chip.chipUnitsFromText(text);
  return handle({ v: 2, seq: seq, items: units.items });
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

  it('载荷版本 0.2.0 且**代码里**没有 setDraft(清空)（那正是覆盖的病根）—— 并附判别力证明', () => {
    expect(chip.PLUGIN_VERSION).toBe('0.2.0');
    expect(JSON.parse(chip.PACKAGE_JSON).version).toBe('0.2.0');
    expect(codeOnly(chip.CLIENT_JS), '代码里又出现 setDraft("") ⇒ 第二次投喂会覆盖第一次')
      .not.toMatch(/\.setDraft\(\s*(?:""|'')/);
    /* ★ 判别力：同一把扫描器喂一句"清空"必须抓到 */
    expect(/\.setDraft\(\s*(?:""|'')/.test(codeOnly(chip.CLIENT_JS + '\ninput.setDraft("");'))).toBe(true);
    /* seq 去重与追加的机制必须在载荷里（不是只写在注释里） */
    expect(chip.CLIENT_JS).toContain('function appliedHas(seq)');
    expect(chip.CLIENT_JS).toContain('function appliedAdd(seq)');
    expect(chip.CLIENT_JS).toContain('appliedHas(seq)) {');
    expect(chip.CLIENT_JS).toContain('var APPLIED_MAX = ' + chip.MAX_APPLIED + ';');
    expect(chip.CLIENT_JS).toContain('function caretToEnd()');
    expect(chip.CLIENT_JS, '没有走内核的追加入口 addFiles').toContain('input.addFiles(refs, [])');
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

  it('该绿：N 个单元 ⇒ **先 focus、不动草稿**、再走 addFiles 追加；回执 occurrences 与期望逐字一致', async () => {
    const text = sc.buildSidebarText('p-绿', [{ topic: '甲' }, { topic: '乙' }]);
    await withPlugin({}, async ({ k, handle }) => {
      const raw = await feed(handle, text, 1);
      const judged = chip.judgeInsertResult(raw, chip.chipUnitsFromText(text).items);
      expect(judged.ok).toBe(true);
      expect(judged.reason).toBeNull();
      expect(judged.added).toBe(2);
      /* 顺序：先解析 session ⇒ focus ⇒ 追加。**没有 setDraft**（那是上一版的病根）。 */
      const kinds = k.calls.map((c) => c[0]);
      expect(kinds[0]).toBe('for');
      expect(kinds).toContain('focus');
      expect(kinds, '又调 setDraft 了 ⇒ 会覆盖已有内容').not.toContain('setDraft');
      expect(raw.route).toBe('addFiles');
      expect(raw.added).toBe(2);
      expect(raw.occurrences.length).toBe(2);
      /* 逐条钉死死 chip 红线与单行内容 */
      expect(raw.occurrences.map((o) => o.source)).toEqual(['reference', 'reference']);
      expect(raw.occurrences.map((o) => o.appearance)).toEqual(['file', 'file']);
      expect(raw.occurrences.map((o) => o.ref)).toEqual(text.split('\n'));
      expect(raw.occurrences.map((o) => o.clipboardText)).toEqual(text.split('\n'));
      expect(raw.occurrences.map((o) => o.label)).toEqual(['甲', '乙']);
      /* node 里没有 DOM ⇒ 光标腿只能报 live（如实，不假装移过） */
      expect(raw.caret).toBe('live');
    });
  });

  it('该红①：内核不接受任何插入路线（返回 false）⇒ **必须 ok:false + 有原因**，不许静默（主进程据此降级成文本）', async () => {
    const text = sc.buildSidebarText('p-红', [{ topic: '甲' }]);
    await withPlugin({ refuse: 'both' }, async ({ handle }) => {
      const raw = await feed(handle, text, 1);
      const judged = chip.judgeInsertResult(raw, chip.chipUnitsFromText(text).items);
      expect(raw.ok).toBe(false);
      expect(judged.ok).toBe(false);
      expect(judged.added).toBe(0);
      expect(String(judged.reason || '')).toContain('两条插入路线都没被接受');
    });
  });

  it('该红②：插入成功但 occurrences 的 source 不是 reference ⇒ 判红（这就是"死 chip"在小尺度下的等价物）', async () => {
    const text = sc.buildSidebarText('p-红2', [{ topic: '甲' }]);
    await withPlugin({ wrongSource: true }, async ({ handle }) => {
      const raw = await feed(handle, text, 1);
      const judged = chip.judgeInsertResult(raw, chip.chipUnitsFromText(text).items);
      expect(judged.ok).toBe(false);
      expect(String(judged.reason || '')).toContain('与期望不符');
    });
  });

  it('没有 seq ⇒ ok:false / `no-seq`（幂等没有依据就不许进输入框）', async () => {
    const text = sc.buildSidebarText('p', [{ topic: '甲' }]);
    await withPlugin({}, async ({ k, handle }) => {
      const units = chip.chipUnitsFromText(text);
      const raw = await handle({ v: 2, items: units.items });
      expect(raw).toMatchObject({ ok: false, reason: 'no-seq' });
      expect(k.calls.filter((c) => c[0] !== 'for')).toEqual([]);   // 连 session 都不去解析
    });
  });

  it('没有主视图 session ⇒ ok:false + `no-main-session`（不许"看起来插了"）', async () => {
    const text = sc.buildSidebarText('p', [{ topic: '甲' }]);
    await withPlugin({}, async ({ k, handle }) => {
      k.scope.sessions.list.getSnapshot = () => ({ byId: { s9: { id: 's9', retainedBy: {} } } });
      const raw = await feed(handle, text, 1);
      expect(raw).toMatchObject({ ok: false, reason: 'no-main-session' });
    });
  });

  it('只读探针（`probe:true`）⇒ 只回答"这个 seq 应用过没有"，**一个字都不写**', async () => {
    const text = sc.buildSidebarText('p-探针', [{ topic: '甲' }]);
    await withPlugin({}, async ({ k, handle }) => {
      const units = chip.chipUnitsFromText(text);
      const before = await handle({ v: 2, seq: 77, probe: true, items: [] });
      expect(before).toMatchObject({ ok: true, probe: true, already: false });
      expect(k.calls.filter((c) => c[0] === 'addFiles' || c[0] === 'insertReference').length).toBe(0);
      await feed(handle, text, 77);
      const after = await handle({ v: 2, seq: 77, probe: true, items: [] });
      expect(after).toMatchObject({ ok: true, probe: true, already: true });
      expect(after.occurrences.filter((o) => o.source === chip.SOURCE).length).toBe(units.items.length);
    });
  });
});

describe('⑮ 追加语义：两批（不同 seq）必须**累计**，第二批不许把第一批顶掉', () => {
  const A = sc.buildSidebarText('p', [{ topic: '甲' }, { topic: '乙' }]);
  const B = sc.buildSidebarText('p', [{ topic: '丙' }, { topic: '丁' }]);

  it('投 A（2 个）+ 投 B（2 个）⇒ occurrences 累计 **4 个**，顺序 = A 然后 B', async () => {
    await withPlugin({}, async ({ k, handle }) => {
      const rA = await feed(handle, A, 101);
      expect(rA.ok).toBe(true);
      const rB = await feed(handle, B, 102);
      const itemsB = chip.chipUnitsFromText(B).items;
      const judgedB = chip.judgeInsertResult(rB, itemsB);
      expect(judgedB.ok, '第二批判红：' + judgedB.reason).toBe(true);
      /* ① 页面侧真值：4 个块，前 2 个是第一批、后 2 个是第二批（**照 source 过滤后再比**） */
      const mine = rB.occurrences.filter((o) => o.source === chip.SOURCE);
      expect(mine.length).toBe(4);
      expect(mine.map((o) => o.ref)).toEqual(A.split('\n').concat(B.split('\n')));
      /* ② 第二批的回执必须说清"写前 2 个、本批 2 个" */
      expect(rB.before.filter((o) => o.source === chip.SOURCE).length).toBe(2);
      expect(rB.added).toBe(2);
      /* ③ 草稿投影里两批都在，且 B 在 A **后面** */
      const draft = String(k.seen.draft);
      expect(draft.indexOf('p/甲')).toBeGreaterThan(-1);
      expect(draft.indexOf('p/丙')).toBeGreaterThan(draft.indexOf('p/乙'));
      /* ④ 全程**没有** setDraft（有它就是覆盖） */
      expect(k.calls.map((c) => c[0])).not.toContain('setDraft');
    });
  });

  it('同一 seq 投两次 ⇒ 仍然 **4 个**（不是 6 个）：第二次直接 `already:true`、一个块都不插', async () => {
    await withPlugin({}, async ({ k, handle }) => {
      await feed(handle, A, 201);
      await feed(handle, B, 202);
      const callsBefore = k.calls.length;
      const again = await feed(handle, B, 202);
      expect(again).toMatchObject({ ok: true, already: true, added: 0 });
      expect(k.seen.occurrences.filter((o) => o.source === chip.SOURCE).length).toBe(4);
      expect(k.calls.length, '第二次投喂居然又碰了内核（说明它没被去重）').toBe(callsBefore);
      const judged = chip.judgeInsertResult(again, chip.chipUnitsFromText(B).items);
      expect(judged.ok).toBe(true);
      expect(judged.already).toBe(true);
      expect(judged.added).toBe(0);
    });
  });

  it('★ 判别力：把 `setDraft("")` 加回去（= 上一版的写法）⇒ 第二批**必须判红**（覆盖被抓住）', async () => {
    const CLEAR = 'try { input.setDraft(""); } catch (e0) {} ';
    const mutantSource = chip.CLIENT_JS.replace('var route = "";', CLEAR + 'var route = "";');
    expect(mutantSource, '变异没落地 ⇒ 这条判据是空转的').not.toBe(chip.CLIENT_JS);
    await withPlugin({ jsSource: mutantSource }, async ({ handle }) => {
      await feed(handle, A, 301);
      const rB = await feed(handle, B, 302);
      const judgedB = chip.judgeInsertResult(rB, chip.chipUnitsFromText(B).items);
      expect(judgedB.ok, '清空之后竟然判绿 ⇒ 判据没抓住"覆盖"').toBe(false);
      expect(String(judgedB.reason || '')).toMatch(/块数不对|与期望不符/);
      /* 现场也确实是"只剩第二批"（2 个），而不是 4 个 */
      expect(rB.occurrences.filter((o) => o.source === chip.SOURCE).length).toBe(2);
    });
  });

  it('★ 另一条逃逸口：清空发生在**读基线之前**（页面自己看不出被清过）⇒ 由主进程台账 `minBefore` 兜住', () => {
    const items = chip.chipUnitsFromText(B).items;
    /* 页面说："写前 0 个、写后 2 个"（它确实读到的就是 0 —— 因为它先把草稿清了） */
    const lying = {
      ok: true, added: 2, before: [], occurrences: items.map((it, i) => ({
        source: chip.SOURCE, appearance: chip.APPEARANCE, ref: it.ref, label: it.label,
        clipboardText: it.clipboardText, offset: i * 8, length: 7
      })), route: 'addFiles'
    };
    /* 没有台账 ⇒ 页面这套说辞自洽，只能信它 */
    expect(chip.judgeInsertResult(lying, items).ok).toBe(true);
    /* 有台账（已投喂过 2 个）⇒ 页面上只该 ≥ 4 个 ⇒ 必须红 */
    const judged = chip.judgeInsertResult(lying, items, { minBefore: 2 });
    expect(judged.ok).toBe(false);
    expect(String(judged.reason || '')).toMatch(/台账|清掉/);
  });
});

describe('⑯ 判据本体（judgeInsertResult）：按 source 过滤 + 末尾恰好多了这一批', () => {
  const T = sc.buildSidebarText('p', [{ topic: '甲' }, { topic: '乙' }]);
  const items = chip.chipUnitsFromText(T).items;
  function occOf(units, from) {
    return units.map((it, i) => ({
      source: chip.SOURCE, appearance: chip.APPEARANCE, ref: it.ref, label: it.label,
      clipboardText: it.clipboardText, offset: (from + i) * 20, length: 19
    }));
  }
  /** 一条"正常追加"的回执：before 是已有的，occurrences = before + 这一批 */
  function receipt(beforeUnits, want, extra) {
    return Object.assign({
      ok: true, added: want.length, route: 'addFiles', caret: 'dom-range',
      before: occOf(beforeUnits || [], 0),
      occurrences: occOf((beforeUnits || []).concat(want), 0)
    }, extra || {});
  }

  it('空框第一批 ⇒ 绿（added = N）', () => {
    const r = chip.judgeInsertResult(receipt([], items), items);
    expect(r.ok).toBe(true);
    expect(r.added).toBe(2);
  });

  it('第二批接在第一批后面 ⇒ 绿（**只许多这一批**，之前的不许动）', () => {
    const r = chip.judgeInsertResult(receipt(items, items), items);
    expect(r.ok).toBe(true);
    expect(r.occurrences.length).toBe(4);
  });

  it('红：块数少了（= 之前的被清掉）', () => {
    const bad = { ok: true, added: 2, before: occOf(items, 0), occurrences: occOf(items, 0) };
    const r = chip.judgeInsertResult(bad, items);
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toMatch(/块数不对|与期望不符/);
  });

  it('红：数量对但**顺序/内容**不对（末尾不是这一批）', () => {
    const swapped = { ok: true, added: 2, before: occOf(items, 0),
      occurrences: occOf(items, 0).concat(occOf(chip.chipUnitsFromText(sc.buildSidebarText('p', [{ topic: '丙' }, { topic: '丁' }])).items, 2)) };
    const r = chip.judgeInsertResult(swapped, items);
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toMatch(/与期望不符/);
  });

  it('红：**原有**块的形状变了（ref 被改写）', () => {
    const before = occOf(items, 0);
    const after = occOf(items, 0).concat(occOf(items, 2));
    after[0] = Object.assign({}, after[0], { ref: '把老的块改写了/甲' });
    const r = chip.judgeInsertResult({ ok: true, added: 2, before: before, occurrences: after }, items);
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toMatch(/原有.*形状变了|不许动已有的块/);
  });

  it('★ 按 source 过滤：别的 source 的块一律不参与本判据（将来 B 粘贴也成块时不会假红）', () => {
    const before = occOf(items, 0);
    const foreign = { source: 'paste', appearance: 'file', ref: 'p/别家的', label: '别家的', clipboardText: 'p/别家的', offset: 5, length: 4 };
    const after = [foreign].concat(occOf(items, 0), occOf(items, 2), [foreign]);
    const r = chip.judgeInsertResult({ ok: true, added: 2, before: before.concat([foreign]), occurrences: after }, items);
    expect(r.ok).toBe(true);
    expect(r.occurrences.every((o) => o.source === chip.SOURCE)).toBe(true);
    expect(r.occurrences.length).toBe(4);
  });

  it('红：`already:true` 却又说 added>0（自相矛盾的回执必须红）', () => {
    const r = chip.judgeInsertResult({ ok: true, already: true, added: 2, occurrences: [] }, items);
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toContain('already');
  });

  it('绿：`already:true` + added 0（同一 seq 的第二次）', () => {
    const r = chip.judgeInsertResult({ ok: true, already: true, added: 0, occurrences: occOf(items, 0) }, items);
    expect(r.ok).toBe(true);
    expect(r.already).toBe(true);
    expect(r.added).toBe(0);
  });

  it('红：插件报失败 ⇒ 原因原样透出（不许变成"成功"）', () => {
    const r = chip.judgeInsertResult({ ok: false, reason: 'no-main-session' }, items);
    expect(r).toMatchObject({ ok: false, reason: 'no-main-session' });
  });
});

describe('⑰ seq 集合的上界：FIFO 只留最近 MAX_APPLIED 个（内存不许无界涨）', () => {
  it('投 65 个不同 seq ⇒ 集合长度封顶 64，最早那个被淘汰（再来就被当成新的一次投喂）', async () => {
    expect(chip.MAX_APPLIED).toBe(64);
    const T = sc.buildSidebarText('p', [{ topic: '甲' }]);
    await withPlugin({}, async ({ handle }) => {
      for (let i = 1; i <= 65; i++) {
        const r = await feed(handle, T, 1000 + i);
        expect(r.ok).toBe(true);
      }
      const view = chip.judgeInsertResult(await feed(handle, T, 1065), chip.chipUnitsFromText(T).items);
      /* 1065 是刚投过的 ⇒ already（集合里还在） */
      expect(view.already).toBe(true);
      /* 1001 已被 FIFO 淘汰 ⇒ 再来一次会**真的再插一批**（这正是"上界"的代价，如实记在这里） */
      const evicted = await feed(handle, T, 1001);
      expect(evicted.already).toBe(false);
      expect(evicted.ok).toBe(true);
      expect(evicted.applied.seqs.length).toBe(chip.MAX_APPLIED);
      expect(evicted.applied.seqs.indexOf(1001)).toBeGreaterThan(-1);
      expect(evicted.applied.seqs.indexOf(1002)).toBe(-1);      // 更早的（1002）已经被挤掉了
    });
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
