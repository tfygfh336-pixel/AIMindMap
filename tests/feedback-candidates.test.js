/* ============================================================
 * tests/feedback-candidates.test.js — 「本地信号 → 反馈选项」纯函数语义的**独立守门层**（vitest，零 Electron）
 * ----------------------------------------------------------------------------
 * 为什么需要这个文件（这是 R6 收尾批补上的那一半，缺口是**实测**出来的）：
 *   冒烟域 50 的 ② 做的是"DOM 选项 × 产品纯函数现算"的对拍，而**两侧同源** —— 两侧都调
 *   `MM.askDeriveFeedbackCandidates`。于是把纯函数改坏时，DOM 与"现算"**一起变**，比对恒等
 *   ⇒ 实测：把候选改成"固定写死"之后，域 50 **18/18 全绿（漏过）**；把写死挪到"真正生成 DOM 那一跳"
 *   才红。也就是说 ② 只守得住「**DOM 照纯函数画**」，**守不住「纯函数自己的语义」**。
 *   ⇒ 本文件是**第二个、且期望值独立推出**的一侧（不调产品同一个函数去算期望）：
 *     夹具手算 + 断言读实现。这正是"两侧同源 ⇒ 对拍恒等 ⇒ 门禁空转"的反面。
 *
 * 锁住什么（每条都要能被注入打红；判别力读数见 `.review/20261016-域50订正/README.md`）：
 *   ① `collectAnswerSignals` 四信号的口径：长度档边界（199/200/1200/1201）· kind · mapWritten · hasCode
 *   ② `deriveFeedbackCandidates` 的**依赖关系**：信号变了候选就变；stars 跨 4 那条线措辞就换档
 *   ③ 每条候选都**指回**真正点亮的信号（没点亮的信号不出现 ⇒ 不凭空编候选）
 *   ④ 顺序固定（len → kind → code → mapWrite = DOM 里选项的先后）· 每条恰 `{text, signal}` 两键 · 条数 ≤ 上限
 *   ⑤ 判别力形态：语义不同的夹具 ⇒ 候选列表**两两不同**（"忽略入参返常量"必红）
 *   ⑥ 结构：**只有一处实现**（`renderer/app-ask.js` 只薄转发）· 本模块**零 DOM / 零 I/O / 零时钟**
 *      · `<script>` 加载顺序在 `app-ask.js` 之前
 *
 * ⚠️ 本文件**先证明过会红**（B4 判别力证明，报文与三记还原读数见 `.review/20261016-域50订正/`）：
 *   · 把 `deriveFeedbackCandidates` 改成"忽略入参、恒返一个常量候选" ⇒ ②③④⑤ 全红；
 *   · 把 `collectAnswerSignals` 改成"忽略入参、恒返同一个对象" ⇒ ①⑤⑥ 之一必红。
 *
 * ⚠️ 文案（候选措辞）是**产品契约**，本文件逐条锁住 —— 改文案 = 改契约，**同批**改这里，别把它当成"手抄数字"。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const FB = require('../src/feedback-candidates.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { collectAnswerSignals, deriveFeedbackCandidates, ASK_FB_MAX_CANDIDATES, SIGNALS } = FB;

/** 纯填充文本（不含任何命令词、不含 ```）—— 让 hasCode 只剩"我显式加进去的那一段"决定 */
const filler = (n) => '答'.repeat(n);

/* ---------------- 夹具：信号与期望**手算**在这里（不调实现去算期望） ----------------
 * 每个夹具声明三件事，互相对照：
 *   · `expectSignals` —— `collectAnswerSignals` 应该报出的四个信号（手算）；
 *   · `sigNames`      —— 由上面的信号**能**点亮哪几条候选、按什么顺序（手算）；
 *   · `bad` / `good`  —— stars ≤ 3 / ≥ 4 两档的措辞（手算，产品契约）。
 * ⚠️ `bad` 与 `good` 是**两档不同的措辞**：同一份信号换一档措辞就变 ⇒ "措辞与 stars 无关"会被抓。 */
const FIXTURES = [
  {
    name: '长回答 + 讲解档 + 围栏代码 + 已落图（四信号全亮）',
    entry: { a: filler(1201) + '\n```\nconst x = 1;\n```', written: true },
    st: { kind: 'explain' },
    expectSignals: { lenBucket: 'long', kind: 'explain', hasCode: true, mapWritten: true },
    sigNames: ['len', 'kind', 'code', 'mapWrite'],
    bad: ['太长太啰嗦，重点不突出', '解释不够生动具体', '代码/命令有错或有坑', '写进导图后发现内容不合适'],
    good: ['够详细、覆盖面全', '解释清楚易懂', '代码/命令可直接照做', '落进导图的内容正合适']
  },
  {
    name: '短回答 + 问答档 + 无代码 + 未落图（两信号）',
    entry: { a: filler(199) },
    st: { kind: 'ask' },
    expectSignals: { lenBucket: 'short', kind: 'ask', hasCode: false, mapWritten: false },
    sigNames: ['len', 'kind'],
    bad: ['太简略，信息量不够', '答非所问，没答到点上'],
    good: ['简短直接，不绕弯', '正面回答了我的问题']
  },
  {
    name: '中等长度 + 问答档 + 行首命令（缩进 4 空格）+ 已落图',
    entry: { a: filler(600) + '\n    git status', written: true },
    st: { kind: 'ask' },
    expectSignals: { lenBucket: 'mid', kind: 'ask', hasCode: true, mapWritten: true },
    sigNames: ['kind', 'code', 'mapWrite'],
    bad: ['答非所问，没答到点上', '代码/命令有错或有坑', '写进导图后发现内容不合适'],
    good: ['正面回答了我的问题', '代码/命令可直接照做', '落进导图的内容正合适']
  },
  {
    name: '中等长度 + 讲解档 + 无代码 + 未落图（中间档不出 len 候选）',
    entry: { a: filler(600) },
    st: { kind: 'explain' },
    expectSignals: { lenBucket: 'mid', kind: 'explain', hasCode: false, mapWritten: false },
    sigNames: ['kind'],
    bad: ['解释不够生动具体'],
    good: ['解释清楚易懂']
  },
  {
    name: '长回答 + 问答档 + 无代码 + 未落图（只有 len 与 kind）',
    entry: { a: filler(1300) },
    st: undefined,
    expectSignals: { lenBucket: 'long', kind: 'ask', hasCode: false, mapWritten: false },
    sigNames: ['len', 'kind'],
    bad: ['太长太啰嗦，重点不突出', '答非所问，没答到点上'],
    good: ['够详细、覆盖面全', '正面回答了我的问题']
  },
  {
    name: '长度档下边界 200（= mid，不是 short）+ 问答档',
    entry: { a: filler(200) },
    st: { kind: 'ask' },
    expectSignals: { lenBucket: 'mid', kind: 'ask', hasCode: false, mapWritten: false },
    sigNames: ['kind'],
    bad: ['答非所问，没答到点上'],
    good: ['正面回答了我的问题']
  }
];

const sigOf = (f) => collectAnswerSignals(f.entry, f.st);
const textsOf = (cands) => cands.map((c) => c.text);
const signalsOf = (cands) => cands.map((c) => c.signal);

/** 剥注释（结构断言用；只求"代码里有没有"，不求精确语法分析） */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('① collectAnswerSignals —— 四个信号的口径（长度档边界 / kind / mapWritten / hasCode）', () => {
  it('长度档的四个边界：199⇒short · 200⇒mid · 1200⇒mid · 1201⇒long（`len` 恒等于字符数）', () => {
    const cases = [[199, 'short'], [200, 'mid'], [1200, 'mid'], [1201, 'long']];
    for (const [n, bucket] of cases) {
      const s = collectAnswerSignals({ a: filler(n) }, { kind: 'ask' });
      expect(s.len).toBe(n);
      expect(s.lenBucket).toBe(bucket);
    }
    expect(FB.LEN_SHORT_BELOW).toBe(200);
    expect(FB.LEN_LONG_ABOVE).toBe(1200);
  });

  it('kind：只有 st.kind === "explain" 是讲解档；其余（ask / 缺省 / st 不给）一律问答档', () => {
    expect(collectAnswerSignals({ a: 'x' }, { kind: 'explain' }).kind).toBe('explain');
    expect(collectAnswerSignals({ a: 'x' }, { kind: 'ask' }).kind).toBe('ask');
    expect(collectAnswerSignals({ a: 'x' }, {}).kind).toBe('ask');
    expect(collectAnswerSignals({ a: 'x' }, undefined).kind).toBe('ask');
  });

  it('mapWritten：只认真值；缺省 / 假值一律 false（不把"没这条字段"当成落过图）', () => {
    expect(collectAnswerSignals({ a: 'x', written: true }, {}).mapWritten).toBe(true);
    expect(collectAnswerSignals({ a: 'x' }, {}).mapWritten).toBe(false);
    expect(collectAnswerSignals({ a: 'x', written: false }, {}).mapWritten).toBe(false);
    expect(collectAnswerSignals({ a: 'x', written: 0 }, {}).mapWritten).toBe(false);
  });

  it('hasCode：围栏代码 / 行首命令（≤8 空格缩进）算代码；句中提到命令、无空白的命令词不算', () => {
    expect(collectAnswerSignals({ a: '看这个：\n```\nx()\n```' }, {}).hasCode).toBe(true);
    expect(collectAnswerSignals({ a: '先跑\n\tgit status' }, {}).hasCode).toBe(true);
    expect(collectAnswerSignals({ a: '先说一句\n        npm ci' }, {}).hasCode).toBe(true);
    expect(collectAnswerSignals({ a: '这里提到过了 npm 装包这件事' }, {}).hasCode).toBe(false);
    expect(collectAnswerSignals({ a: 'npm-install 这个包' }, {}).hasCode).toBe(false);
    expect(collectAnswerSignals({ a: filler(300) }, {}).hasCode).toBe(false);
  });

  it('纯函数：入参一个字节都不改；空/缺省入参也给完整形状（不抛错、不返回 undefined 字段）', () => {
    const entry = { a: filler(1201) + '\n```\nq\n```', written: true };
    const st = { kind: 'explain' };
    const before = JSON.stringify([entry, st]);
    collectAnswerSignals(entry, st);
    expect(JSON.stringify([entry, st])).toBe(before);

    const s = collectAnswerSignals(null, null);
    expect(s).toEqual({ len: 0, lenBucket: 'short', kind: 'ask', mapWritten: false, hasCode: false });
    expect(collectAnswerSignals(undefined, undefined)).toEqual(s);
  });
});

describe('② deriveFeedbackCandidates —— 依赖信号、指回信号、两档措辞只在 stars 跨 4 那条线时换', () => {
  it.each(FIXTURES.map((f) => [f.name, f]))('%s：信号 → 候选（信号序列与措辞逐条等于夹具手算值）', (name, f) => {
    const sig = sigOf(f);
    // 先核"手算的信号"确实就是实现报出的信号（两侧独立：夹具 vs 实现）
    expect({ lenBucket: sig.lenBucket, kind: sig.kind, hasCode: sig.hasCode, mapWritten: sig.mapWritten })
      .toEqual(f.expectSignals);
    // 满意档（stars ≥ 4）
    const good = deriveFeedbackCandidates(sig, 5);
    expect(signalsOf(good)).toEqual(f.sigNames);
    expect(textsOf(good)).toEqual(f.good);
    // 不满意档（stars ≤ 3）
    const bad = deriveFeedbackCandidates(sig, 3);
    expect(signalsOf(bad)).toEqual(f.sigNames);
    expect(textsOf(bad)).toEqual(f.bad);
    // 两档**逐条**不同：措辞不能与 stars 无关
    good.forEach((c, i) => expect(c.text).not.toBe(bad[i].text));
  });

  it('stars 跨 4 那条线：3 ⇒ 不满意档，4 / 5 ⇒ 满意档；null / 0（未点星）落在不满意档', () => {
    const sig = collectAnswerSignals({ a: filler(199) }, { kind: 'ask' });
    expect(textsOf(deriveFeedbackCandidates(sig, 4))).toEqual(['简短直接，不绕弯', '正面回答了我的问题']);
    expect(textsOf(deriveFeedbackCandidates(sig, 5))).toEqual(['简短直接，不绕弯', '正面回答了我的问题']);
    expect(textsOf(deriveFeedbackCandidates(sig, 3))).toEqual(['太简略，信息量不够', '答非所问，没答到点上']);
    expect(textsOf(deriveFeedbackCandidates(sig, null))).toEqual(['太简略，信息量不够', '答非所问，没答到点上']);
    expect(textsOf(deriveFeedbackCandidates(sig, 0))).toEqual(['太简略，信息量不够', '答非所问，没答到点上']);
  });

  it('候选里出现的信号 == 由信号**手算**出来的那一组（没点亮的信号不许凭空出现）', () => {
    for (const f of FIXTURES) {
      const sig = sigOf(f);
      const hand = [];
      if (sig.lenBucket === 'long' || sig.lenBucket === 'short') hand.push('len');
      hand.push('kind');
      if (sig.hasCode) hand.push('code');
      if (sig.mapWritten) hand.push('mapWrite');
      expect(signalsOf(deriveFeedbackCandidates(sig, 3))).toEqual(hand);
      expect(signalsOf(deriveFeedbackCandidates(sig, 5))).toEqual(hand);
    }
  });

  it('形状契约：每条恰有 text / signal 两个键、text 非空字符串、signal 在四词表内；条数 ≤ 上限', () => {
    for (const f of FIXTURES) {
      for (const stars of [0, 3, 4, 5]) {
        const cands = deriveFeedbackCandidates(sigOf(f), stars);
        expect(cands.length).toBeLessThanOrEqual(ASK_FB_MAX_CANDIDATES);
        for (const c of cands) {
          expect(Object.keys(c).sort()).toEqual(['signal', 'text']);
          expect(typeof c.text).toBe('string');
          expect(c.text.length).toBeGreaterThan(0);
          expect(SIGNALS).toContain(c.signal);
        }
      }
    }
    expect(ASK_FB_MAX_CANDIDATES).toBe(4);
    expect(SIGNALS).toEqual(['len', 'kind', 'code', 'mapWrite']);
    // 如实记（别当"截断守住了"读）：现有信号集最多点亮 4 条 == 上限 ⇒ 截断路径**不可达**，
    // 所以这里只能断言"≤ 上限"；断言"截断生效"会是恒假判据（将来加信号才需要补）。
    const maxed = deriveFeedbackCandidates(
      { lenBucket: 'long', kind: 'explain', hasCode: true, mapWritten: true }, 5);
    expect(maxed.length).toBe(ASK_FB_MAX_CANDIDATES);
  });

  it('判别力形态：语义不同的夹具 ⇒ 候选列表**两两不同**（"忽略入参返常量"在这里必红）', () => {
    const lists = FIXTURES.map((f) => JSON.stringify(deriveFeedbackCandidates(sigOf(f), 3)));
    expect(new Set(lists).size).toBe(FIXTURES.length);
    // 同一份信号：跨档措辞必须不同（"忽略 stars 返同一份"在这里必红）
    const sig = { lenBucket: 'long', kind: 'ask', hasCode: true, mapWritten: true };
    expect(JSON.stringify(deriveFeedbackCandidates(sig, 5)))
      .not.toBe(JSON.stringify(deriveFeedbackCandidates(sig, 3)));
  });
});

describe('③ 结构：只有一处实现 / 本模块零 DOM 零 I/O / 加载顺序在 app-ask.js 之前', () => {
  it('renderer/app-ask.js 只薄转发：没有第二份实现，导出面（MM.ask*）保持原样', () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'renderer', 'app-ask.js'), 'utf8'));
    expect(src).not.toMatch(/function\s+deriveFeedbackCandidates\s*\(/);
    expect(src).not.toMatch(/function\s+collectAnswerSignals\s*\(/);
    expect(src).toContain('window.MMFeedbackCandidates');
    expect(src).toContain('MM.askCollectAnswerSignals = collectAnswerSignals');
    expect(src).toContain('MM.askDeriveFeedbackCandidates = deriveFeedbackCandidates');
    expect(src).toContain('MM.ASK_FB_MAX_CANDIDATES = ASK_FB_MAX_CANDIDATES');
  });

  it('src/feedback-candidates.js 是纯函数模块：零 DOM / 零 I/O / 零时钟 / 零随机', () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'feedback-candidates.js'), 'utf8'));
    expect(src).not.toMatch(/\bdocument\b/);
    expect(src).not.toMatch(/\bwindow\s*\./);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\bfs\s*\./);
    expect(src).not.toMatch(/localStorage/);
    expect(src).not.toMatch(/Date\.now/);
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/addEventListener/);
  });

  it('renderer/index.html 加载了本模块，且顺序在 app-ask.js **之前**（否则加载期守卫会响亮抛错）', () => {
    const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
    const at = html.indexOf('<script src="../src/feedback-candidates.js"></script>');
    const ask = html.indexOf('<script src="app-ask.js"></script>');
    expect(at).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(-1);
    expect(at).toBeLessThan(ask);
  });
});
