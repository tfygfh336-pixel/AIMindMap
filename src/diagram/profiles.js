/* ============================================================
 * src/diagram/profiles.js — **剖面（profile）的纯逻辑那一半**（MS4 的数据侧）
 * ------------------------------------------------------------
 * 它只回答三个问题（不碰 renderer、不碰 DOM、零 I/O、零时钟、零随机）：
 *   ① 某个剖面**开哪些能力**（✓）/ 支持但默认关（○）/ 根本不出现（✗）；
 *   ② 某个控件（带 `cap` 声明）在这个剖面里**出不出**（`controlsFor`）；
 *   ③ 这份表**自己有没有毛病**（`profileIssues`：complex 零 ✗ / 【必备】全 ✓ / ✓∩✗ = ∅）。
 *
 * ⚠️ 这份矩阵**不是**本文件自创：它是 `docs/DIAGRAM-MODES.md` §3.2 那张表的**逐格抄本**
 *   （一次性从文档生成）。抄本的**权威仍然是文档**：`tests/diagram-profiles.test.js` 每次跑
 *   都会重新解析文档 §3.2 与本表**逐格对拍**（少一行 / 多一行 / 拼错 / 格子翻面 ⇒ 红）。
 *   它防的就是"代码里的剖面与设计稿里的剖面慢慢不是同一件事"。
 *
 * 记号：`✓` 支持且默认开 · `○` 支持但默认关（开启条件在文档 §3.5）· `✗` 不出现（理由在 §3.3）。
 * 每条能力的字符串 = 按 `PROFILES` 顺序的 5 个记号（`complex` 在最前）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMDiagramProfiles = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 五个剖面（顺序即矩阵列序；改序 = 改所有格子的含义，别改） */
  const PROFILES = Object.freeze(['complex', 'mindmap', 'path', 'logic', 'module']);
  /** 三种记号（封闭集合：出现第四种记号 ⇒ `profileIssues` 判红） */
  const MARKS = Object.freeze(['\u2713', '\u25cb', '\u2717']);
  const ENABLED = MARKS[0];
  const OPTIONAL = MARKS[1];
  const REJECTED = MARKS[2];

  /** 【必备】四条（`C-F1-05` / `C-F4-04` / `C-F5-04` / `C-I-04`）：它们在**任何**剖面都必须 ✓ */
  const REQUIRED = Object.freeze(['C-F1-05', 'C-F4-04', 'C-F5-04', 'C-I-04']);

  /** 矩阵（逐格抄自 `docs/DIAGRAM-MODES.md` §3.2；顺序 = 文档 §2 的行序） */
  const MATRIX_ROWS = Object.freeze([
  ['C-F1-01', '✓✗✗✓✓'],
  ['C-F1-02', '✓✗✓✓✓'],
  ['C-F1-03', '✓✓✓✓✓'],
  ['C-F1-04', '✓✗✗✗✓'],
  ['C-F1-05', '✓✓✓✓✓'],
  ['C-F2-01', '✓✗✗○✓'],
  ['C-F2-02', '✓✗✗○✓'],
  ['C-F2-03', '✓✗✗○✓'],
  ['C-F2-04', '✓✗✗✗✓'],
  ['C-F2-05', '✓✗✗✗✓'],
  ['C-F2-06', '✓✗✗✗✓'],
  ['C-F3-01', '✓✗✗✓✓'],
  ['C-F3-02', '✓✗✗✓✓'],
  ['C-F3-03', '✓✗✗✓✓'],
  ['C-F3-04', '✓✗✗○○'],
  ['C-F3-05', '✓✗✗○○'],
  ['C-F3-06', '✓✗✗✓✓'],
  ['C-F3-07', '✓✗✗✓✓'],
  ['C-F3-08', '✓✗✗✓✓'],
  ['C-F3-09', '✓✗✗✓✓'],
  ['C-F3-10', '✓✗✗✓✗'],
  ['C-F3-11', '✓✗✗✓○'],
  ['C-F3-12', '✓✗✗✓✓'],
  ['C-F3-13', '✓✗✗✓✓'],
  ['C-F3-14', '✓✗✗✓✓'],
  ['C-F3-15', '✓✗✗✓✓'],
  ['C-F3-16', '✓✗✗✓✓'],
  ['C-F3-17', '✓✗✗○○'],
  ['C-F3-18', '✓✗✗✓✓'],
  ['C-F3-19', '✓✗✗✓✓'],
  ['C-F4-01', '✓✗✗✓✓'],
  ['C-F4-02', '✓✓✓✓✓'],
  ['C-F4-03', '✓✓✓✓✓'],
  ['C-F4-04', '✓✓✓✓✓'],
  ['C-F4-05', '✓✗✗○✓'],
  ['C-F4-06', '✓✗✗○✓'],
  ['C-F4-07', '✓✗✗○✓'],
  ['C-F4-08', '✓✓✓✗✗'],
  ['C-F4-09', '○✗✗✗✗'],
  ['C-F4-10', '✓✓✓✗✗'],
  ['C-F5-01', '✓✗✓✓✓'],
  ['C-F5-02', '✓✗✓✓✓'],
  ['C-F5-03', '✓✓✓✓✓'],
  ['C-F5-04', '✓✓✓✓✓'],
  ['C-F6-01', '✓✗✗○✓'],
  ['C-F6-02', '✓✓✓✓✓'],
  ['C-F6-03', '✓✓✓✓✓'],
  ['C-F6-04', '✓✓✓✓✓'],
  ['C-F7-01', '✓✓✓✓✓'],
  ['C-F7-02', '✓✗○✓✓'],
  ['C-F7-03', '✓✗✗✓✓'],
  ['C-F7-04', '✓○✓✓✓'],
  ['C-F7-05', '✓✓✓✗✗'],
  ['C-F8-01', '✓✓✓✓✓'],
  ['C-F8-02', '✓○○✓✓'],
  ['C-F8-03', '○✗✗○✓'],
  ['C-F8-04', '✓✓○✓✓'],
  ['C-F9-01', '✓✓✓✓✓'],
  ['C-F9-02', '✓✓✓✓✓'],
  ['C-F9-03', '○○○○○'],
  ['C-I-01', '✓✗✓✗✗'],
  ['C-I-02', '✓✗○✗✗'],
  ['C-I-03', '✓✗✓✗✗'],
  ['C-I-04', '✓✓✓✓✓'],
  ['C-A-01', '✓✗✗✓○'],
  ['C-A-02', '✓✗✗✓✓'],
  ['C-A-03', '✓✗✗✓✓'],
  ['C-A-04', '✓✗✗✓✓'],
  ['C-A-05', '✓✗✗✓✓'],
  ['C-A-06', '✓✗✗✓✓'],
  ['C-A-07', '○○✗○○'],
  ['C-G-01', '✓✓✓✓✓'],
  ['C-G-02', '✓○○○○'],
  ['C-G-03', '✓○○○○'],
  ['C-G-04', '✓○○○○'],
  ['C-G-05', '✓✓✓✓✓']
  ]);

  const ROW_BY_ID = new Map(MATRIX_ROWS.map((r) => [r[0], r[1]]));

  /** 稳定规则码（错误按码判，不按文案判） */
  const PROFILE_ERRORS = Object.freeze(['E_PROFILE_UNKNOWN', 'E_PROFILE_CAP', 'E_PROFILE_DATA']);

  class ProfileError extends Error {
    constructor(code, message, detail) {
      super(message);
      this.name = 'ProfileError';
      this.code = code;
      this.detail = detail || {};
    }
  }

  function isStr(v) { return typeof v === 'string' && v.length > 0; }

  /** 剖面标识符校验（未知剖面**报错**，不静默当成 complex） */
  function assertProfile(profile) {
    if (PROFILES.indexOf(profile) >= 0) return profile;
    throw new ProfileError('E_PROFILE_UNKNOWN',
      '未知剖面 ' + JSON.stringify(profile) + '：合法取值是 ' + PROFILES.join(' / ')
      + ' —— 未知剖面**不静默当成 complex**（那会让"写错了"看起来像"全开"）',
      { object: { profile: profile }, allowed: PROFILES.slice() });
  }

  /** 某条能力在某剖面里的记号（未知能力 ⇒ undefined；判据会把它当"设计外"） */
  function markOf(profile, capId) {
    assertProfile(profile);
    const row = ROW_BY_ID.get(capId);
    if (row === undefined) return undefined;
    return row[PROFILES.indexOf(profile)];
  }

  /**
   * **剖面 → 能力集合**（本批的核心纯函数）。
   *
   * @param {string} profile `complex|mindmap|path|logic|module`
   * @returns {{profile:string, all:string[], enabled:string[], optional:string[], rejected:string[]}}
   *   `all` = 设计稿里的全部能力（顺序 = 文档 §2 行序）；其余三组按同一顺序过滤
   */
  function expandProfile(profile) {
    assertProfile(profile);
    const idx = PROFILES.indexOf(profile);
    const all = [];
    const enabled = [];
    const optional = [];
    const rejected = [];
    MATRIX_ROWS.forEach((row) => {
      const id = row[0];
      const mark = row[1][idx];
      all.push(id);
      if (mark === ENABLED) enabled.push(id);
      else if (mark === OPTIONAL) optional.push(id);
      else rejected.push(id);
    });
    return { profile: profile, all: all, enabled: enabled, optional: optional, rejected: rejected };
  }

  /** 某剖面是否**能出现**这条能力（✓ 或 ○）；✗ / 未知能力 ⇒ false */
  function supports(profile, capId) {
    const m = markOf(profile, capId);
    return m === ENABLED || m === OPTIONAL;
  }

  /**
   * **控件面契约**（`docs/DIAGRAM-MODES.md` §4.3 第 1/2 条）：
   *   · 每个控件**必须**声明 `cap`（它是哪条能力）—— 没声明 ⇒ 报错（没有归属的控件一定会漏）；
   *   · 控件集合由剖面**生成**（filter 一次），不许在 N 处写 `if (mode === …)`。
   *
   * ⚠️ 本函数只给**纯逻辑结果**（哪些控件该出现）。"切到某个剖面后 `[data-cap]` 集合
   *    **双向相等**"这条判据只能在 renderer 里验（那里的 DOM 才存在）——
   *    那是另一个批的活，本批把断言写成 **renderer 侧 TODO**（见 `.review/20261061/读数.md`）。
   *
   * @param {string} profile
   * @param {Array<{id:string, cap:string}>} controls
   * @returns {{profile:string, shown:Array, hidden:Array}} 按**输入顺序**给（顺序也是确定性的）
   */
  function controlsFor(profile, controls) {
    assertProfile(profile);
    const list = Array.isArray(controls) ? controls : [];
    const shown = [];
    const hidden = [];
    list.forEach((c, i) => {
      const at = 'controls[' + i + ']';
      if (!c || typeof c !== 'object') {
        throw new ProfileError('E_PROFILE_CAP', at + ' 必须是对象 {id, cap}', { object: { index: i } });
      }
      if (!isStr(c.id)) {
        throw new ProfileError('E_PROFILE_CAP', at + '.id 必须是非空字符串', { object: { index: i } });
      }
      if (!isStr(c.cap)) {
        throw new ProfileError('E_PROFILE_CAP',
          at + '（' + c.id + '）没有声明 `cap`：控件必须说清自己属于哪条能力，否则它不受剖面管、一定会漏',
          { object: { control: c.id }, fixes: ['补 cap: "C-…"'] });
      }
      if (ROW_BY_ID.get(c.cap) === undefined) {
        throw new ProfileError('E_PROFILE_CAP',
          at + '（' + c.id + '）声明的 cap = ' + JSON.stringify(c.cap) + ' 不在能力目录里 —— '
          + '这会让"剖面管不到它"看起来像"这条能力不需要"',
          { object: { control: c.id, cap: c.cap }, cap: c.cap, known: MATRIX_ROWS.length });
      }
      (supports(profile, c.cap) ? shown : hidden).push({ id: c.id, cap: c.cap });
    });
    return { profile: profile, shown: shown, hidden: hidden };
  }

  /**
   * 这份表**自己**的三条不变量（与文档 §3.4 的不变量①②一一对应；③的理由/条件在文档里）：
   *   ① `complex` 列零 ✗（= D1「支持全部功能」的可判形式）；
   *   ② 【必备】四条在**每个**剖面都是 ✓；
   *   ③ 每个窄剖面的 `rejected` 非空（"窄"这件事必须能在数据上看得见），
   *      且 ✓∩✗ = ∅（同一格不能既开又关 —— 这一条由"一格只有一个记号"天然成立，仍显式判一遍）。
   * @returns {{ok:boolean, problems:string[], counts:object}}
   */
  function profileIssues() {
    const problems = [];
    const counts = {};
    // 形状：每条能力的字符串长度必须 = 剖面数，且每个记号都合法
    MATRIX_ROWS.forEach((row) => {
      if (typeof row[1] !== 'string' || row[1].length !== PROFILES.length) {
        problems.push('E_PROFILE_DATA: ' + row[0] + ' 的记号串长度 ≠ ' + PROFILES.length);
        return;
      }
      for (let i = 0; i < row[1].length; i++) {
        if (MARKS.indexOf(row[1][i]) < 0) {
          problems.push('E_PROFILE_DATA: ' + row[0] + ' 在第 ' + i + ' 列出现了非法记号 ' + JSON.stringify(row[1][i]));
        }
      }
    });
    // ① complex 零 ✗
    const cx = expandProfile('complex');
    counts.complex = { enabled: cx.enabled.length, optional: cx.optional.length, rejected: cx.rejected.length };
    if (cx.rejected.length) {
      problems.push('E_PROFILE_DATA: complex 列出现了 ' + cx.rejected.length + ' 个 ✗（'
        + cx.rejected.join('/') + '）—— 全开剖面不许关任何能力');
    }
    // ② 【必备】全 ✓
    REQUIRED.forEach((cap) => {
      PROFILES.forEach((p) => {
        if (markOf(p, cap) !== ENABLED) {
          problems.push('E_PROFILE_DATA: 【必备】能力 ' + cap + ' 在剖面 ' + p + ' 里不是 ✓');
        }
      });
    });
    // ③ 窄剖面拒绝集非空 + 交集为空
    PROFILES.forEach((p) => {
      const e = expandProfile(p);
      counts[p] = { enabled: e.enabled.length, optional: e.optional.length, rejected: e.rejected.length };
      if (p !== 'complex' && e.rejected.length === 0) {
        problems.push('E_PROFILE_DATA: 窄剖面 ' + p + ' 的拒绝集为空 —— "窄"这件事在数据上看不见');
      }
      const overlap = e.enabled.filter((id) => e.rejected.indexOf(id) >= 0);
      if (overlap.length) problems.push('E_PROFILE_DATA: 剖面 ' + p + ' 同时"展开"与"拒绝"了 ' + overlap.join('/'));
    });
    return { ok: problems.length === 0, problems: problems, counts: counts };
  }

  /** 全部能力编号（顺序 = 文档 §2 行序） */
  function allCapabilities() { return MATRIX_ROWS.map((r) => r[0]); }

  /** 能力条数（设计稿的"条数不写在正文"⇒ 以本表为准；文档侧由测试对拍） */
  function capabilityCount() { return MATRIX_ROWS.length; }

  return {
    PROFILES: PROFILES,
    MARKS: MARKS,
    ENABLED: ENABLED,
    OPTIONAL: OPTIONAL,
    REJECTED: REJECTED,
    REQUIRED: REQUIRED,
    MATRIX_ROWS: MATRIX_ROWS,
    PROFILE_ERRORS: PROFILE_ERRORS,
    ProfileError: ProfileError,
    markOf: markOf,
    supports: supports,
    expandProfile: expandProfile,
    controlsFor: controlsFor,
    profileIssues: profileIssues,
    allCapabilities: allCapabilities,
    capabilityCount: capabilityCount
  };
});
