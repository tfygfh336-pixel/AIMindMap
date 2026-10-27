/* ============================================================
 * tests/diagram-theme-export.test.js —— **主题（`C-F6-01`…`04`）+ 导出（`C-F8-01` / `C-F9-02`）+ 缺口**
 * ------------------------------------------------------------
 * 这个文件判四件事，**每件都能单独红**：
 *   ① `C-F6-03` 两套 token **键集逐键相同**（缺一个就红 —— 不许"少一个键就用默认"）；
 *   ② `C-F6-02`/`03` 每套的正文对比度 **≥ 4.5:1**（判据**自己**写一份 WCAG 算式复算，不复用实现）；
 *   ③ `C-F6-04` / `C-F8-01` 导出的 SVG **自足**：0 个 `<link rel=stylesheet>`、0 个 `@import`、
 *      0 个 http(s) 外链属性、0 个非片段 `url(…)`；
 *   ④ `C-F9-02` 同输入两跑**逐字节相同**（隔 5ms —— 同毫秒两次跑抓不到"加时间戳"这种坏法）。
 * 外加一条**反向**判据（本工程的规矩："没做"要写在代码里）：
 *   ⑤ `exportCapabilities()` 里 PNG / PDF 必须是 `ok:false` 且写清缺什么 ——
 *      这条红的方式是"有人把它改成 ok:true 却没实现"（那就等于假装做了）。
 * ============================================================ */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';

import D from '../src/diagram/index.js';
import { netfilterDoc } from './diagram-fixture.js';
import { autoDoc } from './diagram-auto-fixture.js';

function sha256(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }

/* ---------------- 判据自己写一份 WCAG 对比度（不复用 `D.contrastRatio`）---------------- */
function luminance(hex) {
  const h = String(hex).replace('#', '');
  const v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = v.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function ratio(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('C-F6-02 / C-F6-03 两套 token：键集逐键相同 + 对比度 ≥ 4.5:1（判据自己算）', () => {
  it('键集**逐键相同**：两套的键数组完全相等', () => {
    const light = Object.keys(D.THEMES.light).sort();
    const dark = Object.keys(D.THEMES.dark).sort();
    expect(dark).toEqual(light);
    expect(light.length).toBeGreaterThanOrEqual(13);
    // 实现自报的差异也必须为空（读数与判据对得上）
    expect(D.themeKeyDiff().missingInDark).toEqual([]);
    expect(D.themeKeyDiff().missingInLight).toEqual([]);
  });

  ['light', 'dark'].forEach((name) => {
    it(name + '：`THEME_PAIRS` 里每一对都 ≥ 4.5:1（逐对现算）', () => {
      const t = D.THEMES[name];
      expect(D.THEME_PAIRS.length).toBeGreaterThanOrEqual(4);
      D.THEME_PAIRS.forEach((p) => {
        const r = ratio(t[p[0]], t[p[1]]);
        expect(r, name + ' 的 ' + p[0] + ' on ' + p[1] + ' = ' + r.toFixed(2) + ':1').toBeGreaterThanOrEqual(4.5);
      });
    });
  });

  it('深色主题**真的换了底**（不是"把文字调浅、底还是白的"）', () => {
    expect(luminance(D.THEMES.dark.canvas)).toBeLessThan(0.05);
    expect(luminance(D.THEMES.light.canvas)).toBeGreaterThan(0.8);
  });
});

describe('C-F6-01 语义 classDef：十类各解析到一个 token，未知类**报错**', () => {
  it('十个语义类在两套主题里都能解析，且同类在两套里颜色不同（换皮真的换了）', () => {
    expect(D.SEMANTIC_CLASSES.length).toBe(10);
    D.SEMANTIC_CLASSES.forEach((k) => {
      const a = D.resolveSemantic(k, 'light');
      const b = D.resolveSemantic(k, 'dark');
      expect(a, k + ' 在 light 里没解析到颜色').toMatch(/^#[0-9a-f]{6}$/);
      expect(b, k + ' 在 dark 里没解析到颜色').toMatch(/^#[0-9a-f]{6}$/);
      expect(a === b, k + ' 在浅/深两套里是同一个颜色（等于没换皮）').toBe(false);
    });
  });

  it('未知语义类 ⇒ 抛 `E_THEME_CLASS` 并列出合法取值（不静默退化成默认色）', () => {
    let err = null;
    try { D.resolveSemantic('protocol-bogus', 'light'); } catch (e) { err = e; }
    expect(err, '未知语义类被静默接受了').not.toBeNull();
    expect(err.code).toBe('E_THEME_CLASS');
    expect(err.detail.allowed).toEqual(D.SEMANTIC_CLASSES.slice());
    expect(err.message).toContain('link');
  });

  it('字面 `#rrggbb` 仍然可用（后向兼容：既有数据的 color 是十六进制直写）', () => {
    expect(D.resolveSemantic('#123456', 'light')).toBe('#123456');
    let err = null;
    try { D.resolveSemantic('#12345', 'light'); } catch (e) { err = e; }
    expect(err.code).toBe('E_THEME_CLASS');                 // 五位不是合法颜色，也不许猜
  });

  it('边数据里写语义类 ⇒ 产物里的 stroke 是那个 token（不是原字符串）', () => {
    const doc = autoDoc();
    doc.graph.edges.forEach((e) => { if (e.id === 'e1') e.color = 'security'; });
    const { svg, report } = D.renderAuto(doc);
    const expectColor = D.SEMANTIC_COLORS.light.security;
    expect(svg).toContain('stroke="' + expectColor + '"');
    expect(svg).not.toContain('"security"'.slice(1, -1) + '"');
    expect(report.theme.semanticClasses).toEqual(D.SEMANTIC_CLASSES);
  });

  it('边数据里写未知语义 ⇒ 渲染**响亮拒绝**（不是画成默认色）', () => {
    const doc = autoDoc();
    doc.graph.edges.forEach((e) => { if (e.id === 'e1') e.color = 'notaclass'; });
    let err = null;
    try { D.renderAuto(doc); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.code).toBe('E_THEME_CLASS');
  });
});

describe('C-F6-04 / C-F8-01 导出内联且自足（0 外链）', () => {
  ['light', 'dark'].forEach((name) => {
    it(name + ' 主题导出：0 个 <link>/@import/外链，且 `checkStandalone` 与判据一致', () => {
      const out = D.exportSVG(netfilterDoc(), { theme: name });
      expect(out.ok, JSON.stringify(out.problems)).toBe(true);
      expect(out.svg).not.toMatch(/<link\b/i);
      expect(out.svg).not.toContain('@import');
      expect(out.svg).not.toMatch(/href\s*=\s*["']https?:/i);
      expect(out.checks.linkRelStylesheet).toBe(0);
      expect(out.checks.imports).toBe(0);
      expect(out.checks.externalUrls).toBe(0);
      expect(out.checks.urlRefs).toBe(0);
    });
  });

  it('深色导出**自带底色**（否则浅色文字在默认白页上看不见）', () => {
    const out = D.exportSVG(netfilterDoc(), { theme: 'dark' });
    expect(out.svg).toContain('data-canvas="1"');
    expect(out.svg).toContain('fill="' + D.THEMES.dark.canvas + '"');
    expect(out.theme).toBe('dark');
  });

  it('浅色导出**不画底色**（画了就等于改 MS1 的逐字节基线）', () => {
    const out = D.exportSVG(netfilterDoc());
    expect(out.svg).not.toContain('data-canvas');
    expect(out.theme).toBe('light');
  });

  it('未知主题 ⇒ 响亮拒绝（不静默退回浅色）', () => {
    let err = null;
    try { D.render(netfilterDoc(), { theme: 'midnight' }); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.code).toBe('E_THEME_UNKNOWN');
    expect(err.detail.allowed).toEqual(['light', 'dark']);
  });

  it('导出就是渲染：浅色导出的字节 == `render()` 的字节（导出层不许偷偷改产物）', () => {
    const a = D.render(netfilterDoc()).svg;
    const b = D.exportSVG(netfilterDoc()).svg;
    expect(sha256(b)).toBe(sha256(a));
  });
});

describe('C-F9-02 导出的结构稳定（同输入两跑逐字节相同，隔 5ms）', () => {
  ['light', 'dark'].forEach((name) => {
    it(name + '：两跑 sha256 相同，且字节数一致', async () => {
      const a = D.exportAuto(autoDoc(), { theme: name });
      await new Promise((r) => setTimeout(r, 5));
      const b = D.exportAuto(autoDoc(), { theme: name });
      expect(sha256(a.svg)).toBe(sha256(b.svg));
      expect(a.bytes).toBe(b.bytes);
      expect(a.bytes).toBe(Buffer.byteLength(a.svg, 'utf8'));   // `utf8Bytes` 与 Buffer 对得上
    });
  });

  it('元素顺序也稳定：两次导出的 `g[data-z]` 序列逐字相同', () => {
    const zOf = (svg) => (svg.match(/<g data-z="([^"]+)"/g) || []).join('|');
    const a = D.exportAuto(autoDoc()).svg;
    const b = D.exportAuto(autoDoc()).svg;
    expect(zOf(b)).toBe(zOf(a));
    expect(zOf(a)).toBe('<g data-z="layers"|<g data-z="containers"|<g data-z="nodes"|<g data-z="edges"'
      + '|<g data-z="edgeLabels"|<g data-z="annotations"');
  });
});

describe('缺口登记（**反向判据**）：PNG / PDF 必须写成"做不到"', () => {
  it('PNG / PDF 是 `ok:false` 且写清缺什么、为什么（改成 ok:true 而没实现 ⇒ 这条红）', () => {
    const caps = D.exportCapabilities();
    expect(caps.svg.ok).toBe(true);
    ['png', 'pdf'].forEach((k) => {
      expect(caps[k].ok, k + ' 被声称能导出了 —— 仓里没有光栅器，那是假装做了').toBe(false);
      expect(caps[k].implemented).toBe(false);
      expect(caps[k].needs.length).toBeGreaterThan(0);
      expect(caps[k].reason.length).toBeGreaterThan(20);
    });
  });

  it('`report.notImplemented` 里仍然写着 png / pdf（读数与能力清单不许两处不一致）', () => {
    const { report } = D.render(netfilterDoc());
    expect(report.notImplemented).toContain('export:png');
    expect(report.notImplemented).toContain('export:pdf');
    expect(report.notImplemented).not.toContain('route:curve');   // curve 已实现
  });

  it('导出的产物里没有位图痕迹（没有 <image>、没有 data: 内嵌图）', () => {
    const svg = D.exportSVG(netfilterDoc()).svg;
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('data:image');
  });
});
