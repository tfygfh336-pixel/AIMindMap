/* ============================================================
 * tests/ui-tokens.test.js —— 界面量化的五条刻度（字号 / 间距 / 对比度 / 圆角 / 可点区）
 * ------------------------------------------------------------
 * 由来：2026-10-27 UI 优化批（`.review/20261062-UI优化/诊断.md`）。改版前实测：
 *   · **13 档字号**（10/11/11.5/12/12.5/13/13.5/14/15/16/18/20/22）——`tells.md` §5
 *     「Nine nearly equal font sizes — warned over 9」；`app-screens.md` §9.1 给 app 的口径是 4–9 档、中位 6
 *   · **间距没有刻度**（1,2,3,5,6,7,9,10,13,14,18,22…）——§9.4「Spacing on a 4px base」
 *   · **正文灰 #86909c 只有 3.24:1**（界面第 1 高频色，53 处），下面还有 2.23 / 2.04 / 1.59 / 1.87 四档
 *     ——§9.2「every tier that carries words reaches 4.5:1」
 *   · **10 种圆角**——§9.4「the inspector warns over three panel radii」
 *   · **控件实测 25.6px 高**——§9.4「Control height 27-40，median 34」
 *
 * 这些刻度为什么必须**机械可查**：它们全是"人手调一次就会漂"的数。
 * 口径：数值只从 `renderer/tokens.css` 读（那是单一登记处），规则从 `style.css` +
 * `draft-map.html` 的内联样式读（草稿窗不引用 style.css，但引用同一份 tokens.css）。
 *
 * 五条都自带**判别力注入**（喂一份"被改坏"的输入，检查器必须报出来）——
 * 照本工程既有做法（`tests/detail-html-contract.test.js` 的「判别力：…」那几条）：
 * 一个不会变红的判据，等于没有判据。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TOKENS_CSS = read('renderer/tokens.css');
const STYLE_CSS = read('renderer/style.css');
const DRAFT_HTML = read('renderer/draft-map.html');
const INDEX_HTML = read('renderer/index.html');
const APP_CORE = read('renderer/app-core.js');
const DRAFT_JS = read('renderer/draft-map.js');

/* 草稿窗的内联 `<style>` 块 —— 与 style.css 同一套刻度，但它是另一张表（不引用 style.css） */
function inlineStyle(html) {
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  return m ? m[1] : '';
}
const DRAFT_CSS = inlineStyle(DRAFT_HTML);
/** 所有"规则表"（token 定义表除外） */
const RULE_SHEETS = [
  { rel: 'renderer/style.css', css: STYLE_CSS },
  { rel: 'renderer/draft-map.html#style', css: DRAFT_CSS },
];

/* ---------------- WCAG 2.x 相对亮度与对比度（现算，不查表） ---------------- */
function srgb(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
export function luminance(hex) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  if (full.length !== 6) return null;
  const r = parseInt(full.slice(0, 2), 16), g = parseInt(full.slice(2, 4), 16), b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return null;
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  if (la === null || lb === null) return null;
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/* ---------------- token 解析 ---------------- */
/** 去掉注释（**必须先去掉**：本工程的注释里写着大量 hex 与 `:root`、还有 `{` `}`，
 *  不剥掉就会把"注释里的色值"当成"规则里的裸 hex"，也会把注释粘进选择器里 —— 实测假红两次） */
export function stripComments(css) {
  return String(css).replace(/\/\*[\s\S]*?\*\//g, '');
}

/** `:root { --a: #fff; ... }` → { '--a': '#fff' }（只认第一段 :root） */
export function parseTokens(css) {
  const m = stripComments(css).match(/:root\s*\{([\s\S]*?)\}/);
  const out = {};
  if (!m) return out;
  for (const decl of m[1].split(';')) {
    const d = decl.match(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+?)\s*$/i);
    if (d) out[d[1]] = d[2];
  }
  return out;
}
const TOKENS = parseTokens(TOKENS_CSS);

/** 把 `var(--x)` 解析成字面值（单层，够本工程用；解析不了返回 null） */
export function resolveVar(value, tokens) {
  const v = String(value).trim();
  const m = v.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)$/i);
  if (!m) return v;
  const raw = (tokens || TOKENS)[m[1]];
  return raw === undefined ? null : String(raw).trim();
}

/* ---------------- 规则切分 ---------------- */
/** 返回 [{ sel, body, rel }]（够用的近似：先剥注释，再按 `}` 切，`{` 前是选择器） */
export function rules(css, rel) {
  const out = [];
  for (const chunk of stripComments(css).split('}')) {
    const i = chunk.indexOf('{');
    if (i < 0) continue;
    out.push({ rel: rel || '', sel: chunk.slice(0, i).trim().replace(/\s+/g, ' '), body: chunk.slice(i + 1) });
  }
  return out;
}
const ALL_RULES = RULE_SHEETS.flatMap((s) => rules(s.css, s.rel));

/* ============================================================
 * ① 字号阶梯：恰好 6 档，且规则里不许直接写 px
 * ============================================================ */
const FS_TOKEN_VALUES = Object.keys(TOKENS).filter((k) => k.indexOf('--fs-') === 0)
  .map((k) => parseFloat(TOKENS[k])).sort((a, b) => a - b);

/** 找出"绕过 token 直接写 px"的字号；返回 [{rel, sel, value}] */
export function rawFontSizes(sheets) {
  const bad = [];
  for (const s of sheets) {
    for (const r of rules(s.css, s.rel)) {
      for (const m of r.body.matchAll(/font-size:\s*([0-9.]+)px/g)) bad.push({ rel: s.rel, sel: r.sel, value: m[1] + 'px' });
    }
  }
  return bad;
}

describe('① 字号阶梯（app-screens §9.1：4–9 档、中位 6；改版前 13 档）', () => {
  it('tokens.css 里的字号恰好这 6 档：12 / 13 / 14 / 16 / 20 / 24', () => {
    expect(FS_TOKEN_VALUES).toEqual([12, 13, 14, 16, 20, 24]);
  });

  it('规则里没有任何 `font-size: <px>` 字面量（一律经 token）', () => {
    const bad = rawFontSizes(RULE_SHEETS);
    expect(bad, '这些地方绕过了 token 直接写字号：' + JSON.stringify(bad.slice(0, 6))).toEqual([]);
  });

  it('判别力：塞一个 `font-size: 15px` 进去 ⇒ 必红', () => {
    const mutated = [{ rel: 'x.css', css: '.a { font-size: 15px; }' }];
    expect(rawFontSizes(mutated).length).toBe(1);
  });

  it('判别力：把某一档从 6 档里拿掉（改 token 值）⇒ 集合比较必红', () => {
    const mutated = parseTokens(TOKENS_CSS.replace('--fs-meta: 12px', '--fs-meta: 12.5px'));
    const vals = Object.keys(mutated).filter((k) => k.indexOf('--fs-') === 0)
      .map((k) => parseFloat(mutated[k])).sort((a, b) => a - b);
    expect(vals).not.toEqual([12, 13, 14, 16, 20, 24]);
  });
});

/* ============================================================
 * ② 间距网格：4 的倍数（app-screens §9.4「Spacing on a 4px base」）
 * ============================================================ */
const SPACE_PROPS = /^(padding|margin|gap|row-gap|column-gap)(-[a-z]+)?$/;

/** 返回所有非 4 倍数的间距声明 */
export function offGridSpacing(sheets) {
  const bad = [];
  for (const s of sheets) {
    for (const r of rules(s.css, s.rel)) {
      for (const decl of r.body.split(';')) {
        const i = decl.indexOf(':');
        if (i < 0) continue;
        const prop = decl.slice(0, i).trim();
        const val = decl.slice(i + 1).trim();
        if (!SPACE_PROPS.test(prop)) continue;
        if (/var\(|calc\(|auto|inherit|%/.test(val)) continue;
        for (const m of val.matchAll(/(-?[0-9.]+)px/g)) {
          const n = parseFloat(m[1]);
          if (n % 4 !== 0) bad.push({ rel: s.rel, sel: r.sel, prop, value: m[1] + 'px' });
        }
      }
    }
  }
  return bad;
}

describe('② 间距网格（4 的倍数；改版前 1/2/3/5/6/7/9/10/13/14/18/22 满地都是）', () => {
  it('style.css + 草稿窗内联样式里的 padding/margin/gap 全部是 4 的倍数', () => {
    const bad = offGridSpacing(RULE_SHEETS);
    expect(bad, '这些间距不是 4 的倍数：' + JSON.stringify(bad.slice(0, 8))).toEqual([]);
  });

  it('判别力：写一个 7px ⇒ 必红', () => {
    const mutated = [{ rel: 'x.css', css: '.a { padding: 7px 8px; }' }];
    expect(offGridSpacing(mutated).length).toBe(1);
  });

  it('判别力：写一个 6px 的 gap ⇒ 必红', () => {
    const mutated = [{ rel: 'x.css', css: '.a { gap: 6px; }' }];
    expect(offGridSpacing(mutated).length).toBe(1);
  });
});

/* ============================================================
 * ③ 对比度：带字的规则一律 ≥4.5:1（现算 WCAG）
 * ============================================================ */
const FALLBACK_SURFACES = ['--surface', '--ground', '--panel'];

/** 一条规则的前景/背景（解析不了返回 null） */
function ruleColors(r, T) {
  const tokens = T || TOKENS;
  const fgM = r.body.match(/(?:^|;|\s)color:\s*([^;]+)/);
  if (!fgM) return null;
  const fg = resolveVar(fgM[1].trim(), tokens);
  if (!fg || fg[0] !== '#') return null;                      // 非 hex（rgba 等）不在这里判，另行登记
  const bgM = r.body.match(/background(?:-color)?:\s*([^;]+)/);
  /* 背景分三种，别混：① 没声明 ⇒ 按最差底算；② hex（含 token）⇒ 直接算这一对；
   * ③ rgba()/none/transparent（半透明浮层、遮罩）⇒ **静态算不出来**，跳过并登记
   *   （`#fd-img-tip` 的白字压 92% 深色浮层就是这一档，见诊断 §6）。 */
  if (bgM) {
    const bg = resolveVar(bgM[1].trim(), tokens);
    if (!bg || bg[0] !== '#') return null;
    return { fg, bg };
  }
  return { fg, bg: null };
}

/** 返回所有"带字但比值 < 4.5"的规则（没有背景声明的按最差底算） */
export function lowContrast(sheets, tokens) {
  const T = tokens || TOKENS;
  const bad = [];
  for (const s of sheets) {
    for (const r of rules(s.css, s.rel)) {
      const c = ruleColors(r, T);
      if (!c) continue;
      let worst;
      if (c.bg) {
        worst = { bg: c.bg, ratio: contrast(c.fg, c.bg) };
      } else {
        for (const name of FALLBACK_SURFACES) {
          const bg = resolveVar('var(' + name + ')', T);
          if (!bg || bg[0] !== '#') continue;
          const ratio = contrast(c.fg, bg);
          if (ratio === null) continue;
          if (!worst || ratio < worst.ratio) worst = { bg, ratio };
        }
      }
      if (worst && worst.ratio !== null && worst.ratio < 4.5) {
        bad.push({ rel: s.rel, sel: r.sel, fg: c.fg, bg: worst.bg, ratio: worst.ratio });
      }
    }
  }
  return bad;
}

describe('③ 对比度（app-screens §9.2 house rule：每一档带字都要 ≥4.5:1）', () => {
  it('WCAG 公式自检：白底黑字 21:1、白底白字 1:1、#86909c on 白 ≈3.24', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrast('#ffffff', '#ffffff')).toBe(1);
    expect(contrast('#86909c', '#ffffff')).toBeCloseTo(3.24, 1);
  });

  it('改版前那个灰（#86909c）在 4.5 线上是不过的 —— 这条判据真的会咬', () => {
    expect(contrast('#86909c', '#ffffff')).toBeLessThan(4.5);
    expect(contrast('#68707d', '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('style.css + 草稿窗内联样式：没有一条"带字且 < 4.5:1"的规则', () => {
    const bad = lowContrast(RULE_SHEETS);
    expect(bad, '这些规则的字对比度不够（< 4.5:1）：' + JSON.stringify(bad.slice(0, 8), null, 1)).toEqual([]);
  });

  it('判别力：把 --ink-3 调淡到 #9aa1ab ⇒ 必红', () => {
    const mutatedTokens = parseTokens(TOKENS_CSS.replace('--ink-3: #68707d', '--ink-3: #9aa1ab'));
    const bad = lowContrast([{ rel: 'x.css', css: '.a { color: var(--ink-3); background: var(--surface); }' }], mutatedTokens);
    expect(bad.length).toBe(1);
  });
});

/* ============================================================
 * ④ 圆角：三档 + 圆 + 胶囊（app-screens §9.4「warns over three panel radii」）
 * ============================================================ */
const ALLOWED_RADII = ['var(--r-card)', 'var(--r-control)', 'var(--r-chip)', 'var(--r-pill)', '50%', '0'];

export function badRadii(sheets) {
  const bad = [];
  for (const s of sheets) {
    for (const r of rules(s.css, s.rel)) {
      for (const m of r.body.matchAll(/border-radius:\s*([^;]+)/g)) {
        const v = m[1].trim();
        if (ALLOWED_RADII.indexOf(v) < 0) bad.push({ rel: s.rel, sel: r.sel, value: v });
      }
    }
  }
  return bad;
}

describe('④ 圆角集合（改版前 10 种：3/4/5/6/8/10/12/20/50%/1.5px）', () => {
  it('所有 border-radius 只能是三档 token / 圆形 / 零', () => {
    const bad = badRadii(RULE_SHEETS);
    expect(bad, '这些圆角不在三档之内：' + JSON.stringify(bad.slice(0, 8))).toEqual([]);
  });

  it('判别力：再写一个 `border-radius: 10px` ⇒ 必红', () => {
    expect(badRadii([{ rel: 'x.css', css: '.a { border-radius: 10px; }' }]).length).toBe(1);
  });
});

/* ============================================================
 * ⑤ 色值单源：规则里不许出现裸 hex（全部经 token）
 * ============================================================ */
export function rawHex(sheets) {
  const bad = [];
  for (const s of sheets) {
    for (const r of rules(s.css, s.rel)) {
      /* `:root` 是 **token 定义处** —— 色值本来就该写在那里面（含 `style.css` 里刻意留下的
       * `--note-link-ink: #8a6a00`，既有单测要求它全文件恰好出现 1 次）。规则体才扫。 */
      if (/^:root\b/.test(r.sel)) continue;
      for (const m of r.body.matchAll(/#[0-9a-fA-F]{3,6}(?![0-9a-fA-F])/g)) bad.push({ rel: s.rel, sel: r.sel, hex: m[0] });
    }
  }
  return bad;
}

describe('⑤ 色值单源（改版前 86 个 hex 硬编码在规则里）', () => {
  it('规则里没有一个裸 hex（注释里的不算 —— 规则体才扫）', () => {
    const bad = rawHex(RULE_SHEETS);
    expect(bad, '这些地方还在硬编码色值：' + JSON.stringify(bad.slice(0, 8))).toEqual([]);
  });

  it('判别力：写一个 `color: #123456` ⇒ 必红', () => {
    expect(rawHex([{ rel: 'x.css', css: '.a { color: #123456; }' }]).length).toBe(1);
  });
});

/* ============================================================
 * ⑥ 可点区台账（app-screens §9.4 控件高 27-40/median 34；§12 触控 44）
 * ------------------------------------------------------------
 * 清单是**台账**：每一行都要有出处（为什么是这一档），新增可点控件必须补一行。
 * 例外（<32）只有两条，且都写明了理由 —— 「不许再降」由本判据守着。
 * ============================================================ */
export const HIT_LEDGER = [
  { sel: /^#toolbar (select|button)/, floor: 32, why: '工具栏按钮（密集行）' },
  { sel: /^\.dialog-actions button/, floor: 32, why: '对话框动作按钮（主操作）' },
  { sel: /^\.mm-ed-actions button/, floor: 32, why: '草稿窗动作按钮（同一形态）' },
  { sel: /^\.ctx-item/, floor: 32, why: '右键菜单项' },
  { sel: /^\.palette-item/, floor: 32, why: '命令面板项' },
  { sel: /^\.ask-acts \.ask-act/, floor: 32, why: 'AI 回答下面的落盘动作' },
  { sel: /^\.ask-stars \.ask-star/, floor: 32, why: '五星评价（孤立手势）' },
  { sel: /^#msg-send/, floor: 32, why: '消息栏发送' },
  { sel: /^#bind-bar-btns button/, floor: 32, why: '绑定状态条按钮' },
  /* 【MS4 断层批】剖面条（`#profile-bar`）—— 页脚那条工具条里的选择器与剖面生成的控件：
   * 与工具栏同一档（密集行），高度必须够点；它是域 58 判据的判读对象（`[data-cap]` 集合）之一，
   * 尺寸变了会让"控件看得见"那条 `elementFromPoint` 判据不再落在控件自己身上。 */
  { sel: /^#profile-bar (select|button)/, floor: 32, why: '剖面条选择器与剖面生成的控件（密集行）' },
  { sel: /^\.mm-banner-btn/, floor: 32, why: '播报条按钮' },
  { sel: /^\.audit-link-btn/, floor: 32, why: '审计面板「建链接」' },
  { sel: /^\.assoc-edit-btn/, floor: 32, why: '关联笔记「编辑」' },
  { sel: /^\.rele-actions button/, floor: 32, why: '关联编辑条的动作按钮' },
  { sel: /^\.rel-show-btn$/, floor: 32, why: '「展示关联节点」整行按钮' },
  { sel: /^\.tag-chip/, floor: 24, why: '标签 chip（§7.6 pill 16-24px，**不适用** 32 的控件下限）' },
  { sel: /^\.float-detail \.fd-head-btns button/, floor: 24, why: '详情框标题栏微钮（标题框高 33px 是域 40 判据⑬ 的硬契约 ⇒ 24 是上界：4+4+24+1=33）' },
  { sel: /^\.fd-item-copy/, floor: 28, why: '条目复制钮（行内微动作）' },
  { sel: /^\.rele-link \.rele-del/, floor: 24, why: '关联 chip 上的删除（行内微动作）' },
  { sel: /^#err-toast-close/, floor: 28, why: '错误条 ✕' },
  { sel: /^#dsh-restore-fab/, floor: 44, why: '重展开圆钮（孤立手势，§12 触控 44）' },
  { sel: /^\.rel-show-btn\.rel-show-btn-round/, floor: 44, why: '关联圆钮（孤立手势）' },
];

/** 逐条查台账：返回没达标的那几条。
 *  认三样声明（按顺序）：`min-height` / `min-width` / `width|height`（孤立手势控件本来就靠
 *  width+height 定尺寸，强制它写 min-height 是形式主义）。选择器按**逗号拆开逐条比**——
 *  `#conc-banner-open, .mm-banner-btn { … }` 这种合写很常见，只比第一段会漏。 */
export function missedHitFloors(ledger, sheets, tokens) {
  const T = tokens || TOKENS;
  const px = (v) => {
    const r = resolveVar(v, T);
    return r && /px$/.test(r) ? parseFloat(r) : null;
  };
  const missed = [];
  for (const row of ledger) {
    let found = null;
    for (const s of sheets) {
      for (const r of rules(s.css, s.rel)) {
        const sels = r.sel.split(',').map((x) => x.trim());
        if (!sels.some((x) => row.sel.test(x))) continue;
        const mh = r.body.match(/min-height:\s*([^;]+)/);
        const mw = r.body.match(/min-width:\s*([^;]+)/);
        const h = r.body.match(/(?:^|;|\s)height:\s*([^;]+)/);
        const w = r.body.match(/(?:^|;|\s)width:\s*([^;]+)/);
        const cand = [mh && px(mh[1]), mw && px(mw[1]), h && px(h[1]), w && px(w[1])].filter((n) => n !== null);
        if (cand.length) found = Math.max.apply(null, cand.concat(found === null ? [] : [found]));
      }
    }
    if (found === null) missed.push({ sel: String(row.sel), why: row.why, floor: row.floor, got: '没写尺寸下限' });
    else if (found < row.floor) missed.push({ sel: String(row.sel), why: row.why, floor: row.floor, got: found });
  }
  return missed;
}

describe('⑥ 可点区台账（≥32 密集行 / ≥44 孤立手势；例外逐条登记）', () => {
  it('--hit-min = 32、--hit-gesture = 44', () => {
    expect(parseFloat(TOKENS['--hit-min'])).toBe(32);
    expect(parseFloat(TOKENS['--hit-gesture'])).toBe(44);
  });

  it('台账里每一条都真的写下了 ≥ 下限的 min-height/min-width', () => {
    const missed = missedHitFloors(HIT_LEDGER, RULE_SHEETS);
    expect(missed, '这些可点控件没达到台账下限：' + JSON.stringify(missed)).toEqual([]);
  });

  it('判别力：把工具栏按钮的下限从 32 缩到 24 ⇒ 必红', () => {
    const mutatedTokens = parseTokens(TOKENS_CSS.replace('--hit-min: 32px', '--hit-min: 24px'));
    const missed = missedHitFloors([{ sel: /^#toolbar button/, floor: 32, why: 'x' }],
      [{ rel: 'x.css', css: '#toolbar button { min-height: var(--hit-min); }' }], mutatedTokens);
    expect(missed.length).toBe(1);
    expect(missed[0].got).toBe(24);
  });
});

/* ============================================================
 * ⑦ 主操作始终可见：动作行永不被滚走（主窗 / 草稿窗各一种做法，都判）
 * ------------------------------------------------------------
 * 由来（实测）：草稿窗视口 805×251 时，`.mm-ed-box`（max-height:88vh≈221px, overflow:auto）
 * 里的动作行被滚出视口 ⇒「保存」点不到，只靠 editor.js 的 scrollIntoView 兜着。
 * 两个页面用的**不是同一种做法**，因为它们的约束不同：
 *   · 主窗 `.dialog-box` 骨架在 `index.html` 里（8 个对话框共用），**不改 DOM** 是硬约束
 *     ⇒ `.dialog-actions` 用 `position: sticky; bottom: 0`（粘底）；
 *   · 草稿窗的骨架由 `editor.js` 现造 ⇒ 用 flex 列 + `.mm-ed-body` 自己滚，
 *     动作行是不动的 flex 项（sticky 会**压在**滚到它下面的内容上，域 56 实测过这个副作用）。
 * 两种都满足同一条不变式：**动作行与滚动容器分离**。几何上的"真的在视口内"由冒烟域 04/56 实测。
 * ============================================================ */
export function stickyActions(sheets) {
  const out = { mainSticky: false, draftFlex: false, draftBodyScrolls: false, draftActionsFixed: false };
  for (const s of sheets) {
    for (const r of rules(s.css, s.rel)) {
      if (r.sel === '.dialog-actions') {
        if (/position:\s*sticky/.test(r.body) && /bottom:\s*0/.test(r.body)) out.mainSticky = true;
      }
      if (r.sel === '.mm-ed-box') {
        if (/display:\s*flex/.test(r.body) && /flex-direction:\s*column/.test(r.body)) out.draftFlex = true;
      }
      if (r.sel === '.mm-ed-body') {
        if (/overflow:\s*auto/.test(r.body)) out.draftBodyScrolls = true;
      }
      if (r.sel === '.mm-ed-actions') {
        if (/flex:\s*0 0 auto/.test(r.body) && !/position:\s*sticky/.test(r.body)) out.draftActionsFixed = true;
      }
    }
  }
  return out;
}

describe('⑦ 主操作始终可见（动作行与滚动容器分离）', () => {
  it('主窗 `.dialog-actions` 粘底；草稿窗 `.mm-ed-box` 是 flex 列 + `.mm-ed-body` 自己滚 + 动作行不滚不压', () => {
    expect(stickyActions(RULE_SHEETS)).toEqual({
      mainSticky: true, draftFlex: true, draftBodyScrolls: true, draftActionsFixed: true,
    });
  });

  it('判别力：去掉 sticky / 去掉 flex 列 ⇒ 必红', () => {
    const r = stickyActions([{ rel: 'x.css', css: '.dialog-actions { display: flex; bottom: 0; }\n.mm-ed-box { display: block; }' }]);
    expect(r.mainSticky).toBe(false);
    expect(r.draftFlex).toBe(false);
  });
});

/* ============================================================
 * ⑧ 持久错误条：骨架在、样式在、接线在（两个窗口各一份）
 * ============================================================ */
describe('⑧ 持久错误条（报错不许被下一句灰色提示盖掉）', () => {
  it('主窗 index.html 有 #err-toast / #err-toast-text / #err-toast-close，且排在脚本之前', () => {
    for (const id of ['err-toast', 'err-toast-text', 'err-toast-close']) {
      expect(INDEX_HTML).toContain('id="' + id + '"');
    }
    expect(INDEX_HTML.indexOf('id="err-toast"')).toBeLessThan(INDEX_HTML.indexOf('src="app-core.js"'));
  });

  it('草稿窗 draft-map.html 有同一套骨架', () => {
    for (const id of ['err-toast', 'err-toast-text', 'err-toast-close']) {
      expect(DRAFT_HTML).toContain('id="' + id + '"');
    }
  });

  it('两个窗口的样式都有 `[hidden] { display: none }`（否则 display:flex 会压过 hidden）', () => {
    expect(STYLE_CSS).toMatch(/#err-toast\[hidden\]\s*\{\s*display:\s*none/);
    expect(DRAFT_CSS).toMatch(/#err-toast\[hidden\]\s*\{\s*display:\s*none/);
  });

  it('两侧接线都在：报错时写进错误条，✕ 能收起', () => {
    expect(APP_CORE).toContain("'#err-toast'");
    expect(APP_CORE).toContain("'#err-toast-close'");
    expect(APP_CORE).toContain('showErrToast');
    expect(DRAFT_JS).toContain("'err-toast'");
    expect(DRAFT_JS).toContain("'err-toast-close'");
  });

  it('错误条让位给原生侧栏（右缘扣 --dsh-sidebar-width），否则会伸到 WebContentsView 底下', () => {
    const block = STYLE_CSS.match(/#err-toast\s*\{[\s\S]*?\}/);
    expect(block).toBeTruthy();
    expect(block[0]).toContain('--dsh-sidebar-width');
  });
});
