/* ============================================================
 * tests/diagram-profiles.test.js —— **剖面（profile）纯逻辑那一半**（MS4 的数据侧）
 * ------------------------------------------------------------
 * 判据四组，**每组都能单独红**：
 *   ① **与设计稿逐格对拍**：本测试**重新解析** `docs/DIAGRAM-MODES.md` §3.2 的矩阵，
 *      与 `src/diagram/profiles.js` 的 `MATRIX_ROWS` 逐格比。少一行 / 多一行 / 拼错 / 格子翻面 ⇒ 红。
 *      （为什么这条最要紧：剖面表的权威在文档，代码是它的抄本；两边一旦漂，
 *        "某个模式暴露了它不该暴露的控件"就再也没人发现得了。）
 *   ② `complex` 展开 = **全量**（零 ✗）：这是 D1「复杂结构模式支持全部功能」的可判形式。
 *   ③ 窄剖面的**拒绝集非空**，且 `✓ ∩ ✗ = ∅`（同一格不能既开又关）。
 *   ④ **控件面契约**：每个控件必须声明 `cap`；`controlsFor` 按剖面过滤；
 *      未声明 / 未登记的 cap ⇒ 报错（不许"没归属的控件"混进来）。
 *
 * ⚠️ 本文件的边界（父批裁决）：`[data-cap]` 集合与剖面展开集合**双向相等**这条判据
 *   只能在 renderer 里验（要 DOM）。本批交的是**纯逻辑的展开函数 + 契约**，
 *   那条断言写成 renderer 侧 TODO（`.review/20261061-参考archify与graphify/读数.md`）。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import D from '../src/diagram/index.js';

const DOC = path.resolve(process.cwd(), 'docs/DIAGRAM-MODES.md');

/** 重新解析文档 §3.2 的矩阵（判据自己写一份解析，不 require `profiles.js`） */
function parseDocMatrix() {
  const md = fs.readFileSync(DOC, 'utf8');
  const begin = md.indexOf('<!-- matrix:begin');
  const end = md.indexOf('<!-- matrix:end -->');
  expect(begin, '文档里找不到 matrix:begin 标记').toBeGreaterThan(-1);
  expect(end, '文档里找不到 matrix:end 标记').toBeGreaterThan(begin);
  const block = md.slice(begin, end);
  const rows = [];
  block.split(/\r?\n/).forEach((line) => {
    const m = /^\|\s*`(C-[A-Z0-9]+-\d{2})`\s*\|\s*([^|]+?)\s*\|(.*)$/.exec(line);
    if (!m) return;
    const cells = m[3].split('|').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\s/g, ''));
    if (cells.length !== 5) return;
    rows.push({ id: m[1], marks: cells.join('') });
  });
  return rows;
}

describe('① 剖面表与设计稿**逐格对拍**（文档是权威，代码是抄本）', () => {
  it('能力条数、顺序、每一格的记号都相同', () => {
    const doc = parseDocMatrix();
    expect(doc.length, '文档 §3.2 的矩阵行数').toBeGreaterThan(50);
    expect(D.capabilityCount(), '代码里的能力条数与文档不同').toBe(doc.length);
    expect(D.profileCapabilities()).toEqual(doc.map((r) => r.id));
    doc.forEach((r) => {
      D.PROFILES.forEach((p, col) => {
        const mine = D.profileMark(p, r.id);
        expect(mine, r.id + ' 在 ' + p + ' 列：代码 = ' + mine + '，文档 = ' + r.marks[col]).toBe(r.marks[col]);
      });
    });
  });

  it('矩阵里的每条能力编号都能在文档 §2 的能力目录里找到（不是凭空多出来的行）', () => {
    const md = fs.readFileSync(DOC, 'utf8');
    const catalog = md.slice(0, md.indexOf('## 3. 模式矩阵'));
    D.profileCapabilities().forEach((id) => {
      expect(catalog.indexOf('`' + id + '`'), id + ' 不在 §2 能力目录里').toBeGreaterThan(-1);
    });
  });
});

describe('② `complex` 展开 = 全量（零 ✗）：D1 的可判形式', () => {
  it('`complex` 的拒绝集为空，且 enabled + optional = 全部能力', () => {
    const e = D.expandProfile('complex');
    expect(e.rejected, 'complex 列出现了 ✗：' + e.rejected.join('/')).toEqual([]);
    expect(e.enabled.length + e.optional.length).toBe(e.all.length);
    expect(e.all.length).toBe(D.capabilityCount());
    expect(e.enabled.length).toBeGreaterThan(0);
  });

  it('`profileIssues()` 三条不变量全过（complex 零 ✗ / 【必备】全 ✓ / 交集为空）', () => {
    const res = D.profileIssues();
    expect(res.ok, res.problems.join('；')).toBe(true);
    expect(res.problems).toEqual([]);
    expect(res.counts.complex.rejected).toBe(0);
  });

  it('【必备】四条在每个剖面都是 ✓（不是只在 complex 里）', () => {
    expect(D.PROFILES_REQUIRED).toEqual(['C-F1-05', 'C-F4-04', 'C-F5-04', 'C-I-04']);
    D.PROFILES.forEach((p) => {
      D.PROFILES_REQUIRED.forEach((cap) => {
        expect(D.profileMark(p, cap), cap + ' 在 ' + p + ' 里不是 ✓').toBe(D.PROFILES_MARKS[0]);
      });
    });
  });
});

describe('③ 窄剖面：拒绝集非空，且 ✓ 与 ✗ 零交集', () => {
  it('四个窄剖面的拒绝集都非空（每一条都点名）', () => {
    D.PROFILES.filter((p) => p !== 'complex').forEach((p) => {
      const e = D.expandProfile(p);
      expect(e.rejected.length, p + ' 的拒绝集为空 —— "窄"在数据上看不见').toBeGreaterThan(0);
      e.rejected.forEach((id) => expect(typeof id).toBe('string'));
    });
  });

  it('任何剖面：展开集（enabled ∪ optional）与拒绝集**零交集**', () => {
    D.PROFILES.forEach((p) => {
      const e = D.expandProfile(p);
      const shown = e.enabled.concat(e.optional);
      const overlap = shown.filter((id) => e.rejected.indexOf(id) >= 0);
      expect(overlap, p + ' 同时展开与拒绝了 ' + overlap.join('/')).toEqual([]);
      expect(shown.length + e.rejected.length).toBe(e.all.length);
    });
  });

  it('未知剖面 ⇒ 报错（不静默当成 complex）', () => {
    let err = null;
    try { D.expandProfile('mindmap2'); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.code).toBe('E_PROFILE_UNKNOWN');
    expect(err.detail.allowed).toEqual(D.PROFILES.slice());
  });
});

describe('④ 控件面契约（`data-cap` 那条判据的**数据侧**）', () => {
  const CONTROLS = [
    { id: 'btn-route-ortho', cap: 'C-F3-06' },
    { id: 'btn-route-curve', cap: 'C-F3-05' },
    { id: 'btn-layer-band', cap: 'C-F2-04' },
    { id: 'btn-radial', cap: 'C-F4-09' },
    { id: 'btn-export-svg', cap: 'C-F8-01' }
  ];

  it('按剖面过滤：complex 全出；mindmap 只出它支持的那几个', () => {
    const cx = D.controlsFor('complex', CONTROLS);
    expect(cx.shown.map((c) => c.id)).toEqual(CONTROLS.map((c) => c.id));
    expect(cx.hidden).toEqual([]);

    const mm = D.controlsFor('mindmap', CONTROLS);
    expect(mm.shown.map((c) => c.id)).toEqual(['btn-export-svg']);
    expect(mm.hidden.map((c) => c.id)).toEqual(['btn-route-ortho', 'btn-route-curve', 'btn-layer-band', 'btn-radial']);
  });

  it('`shown` 与"该剖面 ✓/○ 的 cap"逐条对得上（不是另一套判法）', () => {
    D.PROFILES.forEach((p) => {
      const res = D.controlsFor(p, CONTROLS);
      res.shown.forEach((c) => expect(D.profileSupports(p, c.cap), p + '/' + c.id + ' 被展开了但能力是 ✗').toBe(true));
      res.hidden.forEach((c) => expect(D.profileSupports(p, c.cap), p + '/' + c.id + ' 被藏了但能力是支持的').toBe(false));
    });
  });

  it('可选能力（○）的控件在默认态**出现**（○ 是"支持但默认关"，不是"不出现"）', () => {
    const radial = CONTROLS.filter((c) => c.id === 'btn-radial');
    const cx = D.controlsFor('complex', radial);      // C-F4-09 在 complex 是 ○
    expect(D.profileMark('complex', 'C-F4-09')).toBe(D.PROFILES_MARKS[1]);
    expect(cx.shown.length).toBe(1);
  });

  it('控件没声明 `cap` ⇒ 报错（"没归属的控件"不受剖面管，一定会漏）', () => {
    let err = null;
    try { D.controlsFor('complex', [{ id: 'x' }]); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.code).toBe('E_PROFILE_CAP');
    expect(err.message).toContain('cap');
  });

  it('控件声明了目录里没有的 cap ⇒ 报错（不许"剖面管不到它"看起来像"不需要"）', () => {
    let err = null;
    try { D.controlsFor('complex', [{ id: 'x', cap: 'C-Z-99' }]); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.code).toBe('E_PROFILE_CAP');
    expect(err.detail.cap).toBe('C-Z-99');
  });

  it('空控件面是合法输入（不是"没数据就崩"）', () => {
    const res = D.controlsFor('path', []);
    expect(res.shown).toEqual([]);
    expect(res.hidden).toEqual([]);
  });
});
