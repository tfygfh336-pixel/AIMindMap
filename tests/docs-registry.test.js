/* ============================================================
 * tests/docs-registry.test.js — 文档登记门禁（G8）单元测试（vitest）
 * ------------------------------------------------------------
 * 为什么要给"门禁"本身写单测：门禁最危险的失效方式不是报错，而是
 * **永远通过**（解析不到 §5 表 → 登记集合为空 → 不报任何问题，却宣称合规）。
 * 这里用两类断言把这种失效钉死：
 *   1) 纯函数（§5 表解析 / 登记判定）在合成输入上的行为；
 *   2) **判别力注入**：在临时目录里造一个"有表外文档 + 散落文档"的假工程，
 *      断言门禁必须报出 unregistered / stray —— 证明它不是假守护；
 *   3) 真实工程当前合规（若谁再放表外文档，npm test 同样变红）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import checker from '../scripts/docs-registry-check.js';

const { parseRegistryTable, isRegistered, checkRegistry, section5, handoverNotice, recentlyChanged } = checker;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 造一份最小可用的 §5 登记表（含精确条目与 archive 前缀条目） */
function fakeRegistry() {
  return [
    '# 架构设计',
    '',
    '## 4b. 架构决策记录',
    '',
    '| 决策 | 内容 |',
    '|------|------|',
    '| 单一真源 | 只维护本目录 |',
    '',
    '## 5. 文档架构（每份文档的作用与边界）',
    '',
    '| 层 | 文档 | 作用 |',
    '|----|------|------|',
    '| 入口 | `SKILL.md` | 触发与导航 |',
    '| 入口 | `README.md` | 产品门面 |',
    '| 记录 | `CHANGELOG.md` | 变更轨迹 |',
    '| 设计 | `docs/ARCHITECTURE.md` | 分层决策 |',
    '| 归档 | `docs/archive/*` | 历史快照 |',
    '',
    '## 6. 演进指引',
    '',
    '| 想做什么 | 改哪里 |',
    '|---------|--------|',
    '| 加命令 | `cli/registry.js` |',
    ''
  ].join('\n');
}

describe('docs-registry-check：§5 登记表解析', () => {
  it('section5 只截取 §5 段，不越界到 §4b / §6', () => {
    const sec = section5(fakeRegistry()).join('\n');
    expect(sec).toContain('docs/ARCHITECTURE.md');
    expect(sec).toContain('docs/archive/*');
    expect(sec).not.toContain('cli/registry.js');   // §6 的行不得混入
    expect(sec).not.toContain('单一真源');           // §4b 的行不得混入
  });

  it('抽取精确条目与前缀条目，忽略非文档路径与加粗标记', () => {
    const reg = parseRegistryTable(fakeRegistry());
    expect(reg.found).toBe(true);
    expect(reg.exact.has('SKILL.md')).toBe(true);
    expect(reg.exact.has('docs/ARCHITECTURE.md')).toBe(true);
    expect(reg.exact.has('cli/registry.js')).toBe(false);   // 非 .md 不登记
    expect(reg.prefixes).toContain('docs/archive/');
  });

  it('加粗包裹的路径（**`docs/RULES.md`**）也能抽出', () => {
    const md = '## 5. 文档架构\n\n| 层 | 文档 |\n|----|------|\n| 治理 | **`docs/RULES.md`** |\n';
    expect(parseRegistryTable(md).exact.has('docs/RULES.md')).toBe(true);
  });

  it('占位写法（如 `vX.Y.Z.md`）不算登记项 —— 否则 §5 里的说明文字会被误判成"悬挂登记"', () => {
    const md = '## 5. 文档架构\n\n| 层 | 文档 | 说明 |\n|----|------|------|\n'
      + '| 归档 | `docs/changelog/*` | 文件名 = 版本号（`vX.Y.Z.md`） |\n';
    const reg = parseRegistryTable(md);
    expect(reg.exact.has('vX.Y.Z.md')).toBe(false);
    expect(reg.prefixes).toContain('docs/changelog/');
  });

  it('缺 §5 段时 found=false（门禁据此报"登记表缺失"，而不是静默通过）', () => {
    expect(parseRegistryTable('# 架构\n\n## 1. 分层\n').found).toBe(false);
  });

  it('isRegistered：精确命中与前缀命中都为真', () => {
    const reg = parseRegistryTable(fakeRegistry());
    expect(isRegistered(reg, 'README.md')).toBe(true);
    expect(isRegistered(reg, 'docs/archive/OLD-2020.md')).toBe(true);
    expect(isRegistered(reg, 'docs/UNREGISTERED-EXAMPLE.md')).toBe(false);
  });
});

/** 在临时目录造一个假工程，返回 [根目录, 清理函数]（模块级：多个 describe 共用） */
function fakeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-docs-registry-'));
  Object.entries(files).forEach(([rel, body]) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  });
  return [root, () => fs.rmSync(root, { recursive: true, force: true })];
}

describe('docs-registry-check：判别力注入（证明不是假守护）', () => {
  it('表外文档（docs/ 下未登记）必红 → unregistered', () => {
    const [root, clean] = fakeProject({
      'SKILL.md': '# s', 'README.md': '# r', 'CHANGELOG.md': '# c',
      'docs/ARCHITECTURE.md': '# a',
      'docs/UNREGISTERED-EXAMPLE.md': '# 表外文档'
    });
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      const hit = problems.find((p) => p.rel === 'docs/UNREGISTERED-EXAMPLE.md');
      expect(hit).toBeTruthy();
      expect(hit.kind).toBe('unregistered');
    } finally { clean(); }
  });

  it('散落文档（工程根未登记 md / 非 docs 目录下的 html）必红 → stray', () => {
    const [root, clean] = fakeProject({
      'SKILL.md': '# s', 'README.md': '# r', 'CHANGELOG.md': '# c',
      'docs/ARCHITECTURE.md': '# a',
      'NOTES.md': '# 根目录散落文档',
      '1111111111DOUBAO/analysis.html': '<html></html>'
    });
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      const strays = problems.filter((p) => p.kind === 'stray').map((p) => p.rel).sort();
      expect(strays).toEqual(['1111111111DOUBAO/analysis.html', 'NOTES.md']);
    } finally { clean(); }
  });

  it('乱放的非文档文件与陌生顶层目录也必红 → junk（不只 md/html）', () => {
    const [root, clean] = fakeProject({
      'SKILL.md': '# s', 'README.md': '# r', 'CHANGELOG.md': '# c',
      'docs/ARCHITECTURE.md': '# a',
      'report.json': '{}',
      'probe.js': '// 探针',
      'shot.png': 'binary',
      'my-analysis/notes.txt': 'x'
    });
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      const junk = problems.filter((p) => p.kind === 'junk').map((p) => p.rel).sort();
      expect(junk).toEqual(['my-analysis/', 'probe.js', 'report.json', 'shot.png']);
    } finally { clean(); }
  });

  it('.review/ 是工作产物区：任意文件都允许（含 .md 汇报稿），与 §5 第 3 条一致', () => {
    const [root, clean] = fakeProject({
      'SKILL.md': '# s', 'README.md': '# r', 'CHANGELOG.md': '# c',
      'docs/ARCHITECTURE.md': '# a',
      '.review/20260925-复核报告.md': '# 分析稿',
      '.review/vision/20260925-读图.json': '{}',
      '.review/probe.js': '// 探针'
    });
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      expect(problems.filter((p) => p.rel.startsWith('.review')).map((p) => p.kind)).toEqual([]);
    } finally { clean(); }
  });

  it('合规工程零问题，且 renderer/*.html 与归档族（archive / changelog）不算散落', () => {
    const [root, clean] = fakeProject({
      // SKILL.md 必须提到 §5 登记的每份文档（导航可达判定 checkNavCoverage），**含它自己**
      'SKILL.md': '# s（本文件即 `SKILL.md`）\n\n- 入口：`README.md` / `CHANGELOG.md`\n- 架构：`docs/ARCHITECTURE.md`\n',
      'README.md': '# r', 'CHANGELOG.md': '# c',
      'docs/ARCHITECTURE.md': '# a',
      'renderer/index.html': '<html></html>',
      'docs/archive/OLD-2020.html': '<!DOCTYPE html>\n<!-- 历史归档：勿作现状引用 -->\n<html></html>',
      'docs/changelog/v0.1.0.md': '> 历史归档（滚动归档）：勿作现状引用\n\n# 滚动归档的历史版本段',
      'docs/changelog/v0.2.0.md': '> 历史归档（滚动归档）：勿作现状引用\n\n# 同上'
    });
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      expect(problems).toEqual([]);
    } finally { clean(); }
  });

  it('归档族里的文档**不需要逐份登记**（由 §5 的一行前缀覆盖）', () => {
    const [root, clean] = fakeProject({
      'SKILL.md': '# s', 'README.md': '# r', 'CHANGELOG.md': '# c',
      'docs/ARCHITECTURE.md': '# a',
      'docs/changelog/v0.9.9.md': '# 没登记过，但属于归档族 → 放行'
    });
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      expect(problems.filter((p) => p.rel.startsWith('docs/changelog'))).toEqual([]);
    } finally { clean(); }
  });

  it('悬挂登记（表里写了、磁盘上没有）必红 → dangling', () => {
    const [root, clean] = fakeProject({
      'SKILL.md': '# s', 'README.md': '# r', 'CHANGELOG.md': '# c'
      // 故意不建 docs/ARCHITECTURE.md
    });
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      const hit = problems.find((p) => p.rel === 'docs/ARCHITECTURE.md');
      expect(hit).toBeTruthy();
      expect(hit.kind).toBe('dangling');
    } finally { clean(); }
  });

  it('归档族与主文件重复版本段必红 → duplicate（两边都不进 G6 扫描，只能靠这条抓）', () => {
    const [root, clean] = fakeProject({
      'SKILL.md': '# s', 'README.md': '# r',
      'CHANGELOG.md': '# C\n\n## [Unreleased]\n\n- x\n\n## [v0.12.0] - 2026-09-14\n\n- 旧段还在主文件里\n',
      'docs/ARCHITECTURE.md': '# a',
      'docs/changelog/v0.12.0.md': '# 归档 · v0.12.0\n\n## [v0.12.0] - 2026-09-14\n\n- 同一段'
    });
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      const dup = problems.filter((p) => p.kind === 'duplicate');
      expect(dup.map((p) => p.rel)).toEqual(['docs/changelog/v0.12.0.md']);
    } finally { clean(); }
  });

  it('主文件已删掉该段（正常归档态）→ 不报 duplicate', () => {
    const [root, clean] = fakeProject({
      'SKILL.md': '# s', 'README.md': '# r',
      'CHANGELOG.md': '# C\n\n## [Unreleased]\n\n- x\n\n## [v0.15.0] - 2026-09-16\n\n- 新段\n',
      'docs/ARCHITECTURE.md': '# a',
      'docs/changelog/v0.12.0.md': '# 归档 · v0.12.0\n\n## [v0.12.0] - 2026-09-14\n\n- 只有归档里有'
    });
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      expect(problems.filter((p) => p.kind === 'duplicate')).toEqual([]);
    } finally { clean(); }
  });
});

describe('docs-registry-check：交接面「在飞 / 未收口」指针', () => {
  const withRoadmap = (body) => ({
    'SKILL.md': '# s', 'README.md': '# r', 'CHANGELOG.md': '# c',
    'docs/ARCHITECTURE.md': '# a',
    'docs/ROADMAP.md': '# 路线图\n\n' + body,
    '.review/20260101-在飞主题/README.md': '在飞'
  });

  it('指针指向存在的目录 → 不报（常态）', () => {
    const [root, clean] = fakeProject(withRoadmap(
      '## 在飞 / 未收口\n\n| 状态 | 主题 |\n|---|---|\n| 在飞 | 某事 |\n\n证据：`.review/20260101-在飞主题/`\n'));
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      expect(problems.filter((p) => p.kind === 'handover')).toEqual([]);
    } finally { clean(); }
  });

  it('指针指向已被删的工作目录 → 报 handover 死指针（实测过的场景）', () => {
    const [root, clean] = fakeProject(withRoadmap(
      '## 在飞 / 未收口\n\n证据：`.review/20200101-已删除的工作/`\n'));
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      const hit = problems.find((p) => p.kind === 'handover');
      expect(hit).toBeTruthy();
      expect(hit.msg).toContain('20200101-已删除的工作');
      expect(hit.rel).toMatch(/^docs\/ROADMAP\.md:/);
    } finally { clean(); }
  });

  it('占位写法（`.review/<目录>` / `.review/*`）不算指针 —— 那是规矩文字，不是引用', () => {
    const [root, clean] = fakeProject(withRoadmap(
      '## 在飞 / 未收口\n\n> 规矩：证据指针指向的 `.review/<目录>` 由门禁校验（见 `.review/*`）。\n\n'
      + '证据：`.review/20260101-在飞主题/`\n'));
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      expect(problems.filter((p) => p.kind === 'handover')).toEqual([]);
    } finally { clean(); }
  });

  it('没有「在飞」小节时不判（该小节不是强制存在）', () => {
    const [root, clean] = fakeProject(withRoadmap('## 待办\n\n- 某事\n'));
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      expect(problems.filter((p) => p.kind === 'handover')).toEqual([]);
    } finally { clean(); }
  });
});

describe('docs-registry-check：代码入档 / 归档横幅 / 工作目录状态', () => {
  const base = {
    'SKILL.md': '# s', 'README.md': '# r', 'CHANGELOG.md': '# c',
    'docs/ARCHITECTURE.md': '# 架构\n\n| `known.js` | 已有模块 |\n'
  };

  it('src/ 下未入档的模块必红 → module-cover（接手者靠 §2 认识代码结构）', () => {
    const [root, clean] = fakeProject(Object.assign({}, base, {
      'src/known.js': '// ok',
      'src/brand-new.js': '// 没进架构文档'
    }));
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      const hit = problems.find((p) => p.kind === 'module-cover');
      expect(hit).toBeTruthy();
      expect(hit.rel).toBe('src/brand-new.js');
    } finally { clean(); }
  });

  it('cli/commands 与 scripts 顶层同样纳入；tests/ 与 scripts/smoke 豁免', () => {
    const [root, clean] = fakeProject(Object.assign({}, base, {
      'cli/commands/newcmd.js': '// 未入档',
      'scripts/newtool.js': '// 未入档',
      'tests/whatever.test.js': '// 豁免',
      'scripts/smoke/99-x.js': '// 豁免'
    }));
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      const rels = problems.filter((p) => p.kind === 'module-cover').map((p) => p.rel).sort();
      expect(rels).toEqual(['cli/commands/newcmd.js', 'scripts/newtool.js']);
    } finally { clean(); }
  });

  it('归档文档缺「历史」横幅必红 → banner（grep 到旧稿会当成现状）', () => {
    const [root, clean] = fakeProject(Object.assign({}, base, {
      'docs/archive/OLD-2020.md': '# 旧审查\n\n正文\n'
    }));
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      expect(problems.find((p) => p.kind === 'banner').rel).toBe('docs/archive/OLD-2020.md');
    } finally { clean(); }
  });

  it('归档文档带横幅（含 HTML 注释形式）→ 不报', () => {
    const [root, clean] = fakeProject(Object.assign({}, base, {
      'docs/archive/OLD-2020.md': '> ⚠️ 历史归档：不是现状、勿据此改动。\n\n# 旧审查\n',
      'docs/archive/OLD.html': '<!DOCTYPE html>\n<!-- 历史归档（2026-09）：勿作现状引用 -->\n<html></html>\n'
    }));
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      expect(problems.filter((p) => p.kind === 'banner')).toEqual([]);
    } finally { clean(); }
  });

  it('横幅检查是**递归**的：归档子目录里的旧稿同样必须带横幅（旧实现只扫一层）', () => {
    const [root, clean] = fakeProject({ 'docs/archive/sub/OLD.md': '# 旧稿没有横幅\n\n正文\n' });
    try {
      const hits = checker.checkArchiveBanners(root);
      expect(hits.some((h) => h.kind === 'banner' && h.rel === 'docs/archive/sub/OLD.md')).toBe(true);
    } finally { clean(); }
  });

  it('归档子目录里带横幅 → 不报（递归不等于一律报红）', () => {
    const [root, clean] = fakeProject({ 'docs/archive/sub/OLD.md': '> 历史归档（2026-09）：不是现状\n\n正文\n' });
    try {
      expect(checker.checkArchiveBanners(root)).toEqual([]);
    } finally { clean(); }
  });

  it('.review 的工作目录缺 README（没声明死活）必红 → workdir；散落文件豁免', () => {
    const [root, clean] = fakeProject(Object.assign({}, base, {
      '.review/20260101-有状态/README.md': '状态：在飞\n',
      '.review/20260101-无状态/notes.md': '# 没声明死活\n',
      '.review/loose-file.js': '// 散落文件，豁免\n'
    }));
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      const rels = problems.filter((p) => p.kind === 'workdir').map((p) => p.rel);
      expect(rels).toEqual(['.review/20260101-无状态/']);
    } finally { clean(); }
  });
});

describe('docs-registry-check：契约覆盖 / 章节编号 / 交接提示', () => {
  const base = {
    'SKILL.md': '# s（`SKILL.md`）\n`README.md` `CHANGELOG.md` `docs/ARCHITECTURE.md`\n',
    'README.md': '# r', 'CHANGELOG.md': '# c\n\n## [Unreleased]\n\n### 一条已完成未发版\n',
    'docs/ARCHITECTURE.md': '# a'
  };

  it('schema 校验的字段必须在数据契约里（meta.layout 就是这么漏的）→ contract', () => {
    const [root, clean] = fakeProject(Object.assign({}, base, {
      'src/schema.js': 'data.meta.layout; data.meta.name; data.format; data.data;',
      'docs/DATA-FORMAT.md': 'meta.name 只有这个字段\n'
    }));
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      const hit = problems.filter((p) => p.kind === 'contract').map((p) => p.msg).join(' ');
      expect(hit).toContain('meta.layout');
    } finally { clean(); }
  });

  it('检查表自己过期（清单标了"schema 校验"、schema 里却没有）→ contract-stale', () => {
    const [root, clean] = fakeProject(Object.assign({}, base, {
      'src/schema.js': 'data.meta.layout;',
      'docs/DATA-FORMAT.md': 'meta.name meta.layout\n'
    }));
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      expect(problems.some((p) => p.kind === 'contract-stale')).toBe(true);
    } finally { clean(); }
  });

  it('章节编号断号必红 → numbering（顶层与二级都查）', () => {
    const [root, clean] = fakeProject(Object.assign({}, base, {
      'docs/DATA-FORMAT.md': '# d\n\n## 1. A\n\n### 1.1 x\n\n### 1.3 y\n\n## 3. C\n'
    }));
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      const msgs = problems.filter((p) => p.kind === 'numbering').map((p) => p.msg);
      expect(msgs.some((m) => /二级章节编号断号/.test(m))).toBe(true);
      expect(msgs.some((m) => /顶级章节编号断号/.test(m))).toBe(true);
    } finally { clean(); }
  });

  it('编号连续（含从 0 起、含无编号章节）→ 不报', () => {
    const [root, clean] = fakeProject(Object.assign({}, base, {
      'docs/DATA-FORMAT.md': '# d\n\n## 0. 前言\n\n## 1. A\n\n### 1.1 x\n\n### 1.2 y\n\n## 2. B\n\n## 语义标题\n'
    }));
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      expect(problems.filter((p) => p.kind === 'numbering')).toEqual([]);
    } finally { clean(); }
  });

  it('交接提示：[Unreleased] 有内容而在飞为空 → 给提示，但**不算违规**', () => {
    const [root, clean] = fakeProject(Object.assign({}, base, {
      'docs/ROADMAP.md': '# 路线图\n\n## 在飞 / 未收口\n\n> 说明\n\n## 待办\n'
    }));
    try {
      const notice = handoverNotice(root);
      expect(notice).toBeTruthy();
      expect(notice).toContain('[Unreleased]');
      const { problems } = checkRegistry(root, fakeRegistry());
      expect(problems.filter((p) => p.kind === 'handover')).toEqual([]);   // 提示 ≠ 违规
    } finally { clean(); }
  });
});

describe('docs-registry-check：并发改动检测（多会话场景）', () => {
  /** 某目录下所有文件的 mtimeMs 最大值（取"文件系统时钟"当基准用；见下面那条用例的注释） */
  function maxMtimeMsUnder(dir) {
    let newest = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) newest = Math.max(newest, maxMtimeMsUnder(abs));
      else if (e.isFile()) newest = Math.max(newest, fs.statSync(abs).mtimeMs);
    }
    return newest;
  }

  it('recentlyChanged：窗口内的文件被列出，窗口外的与未来时间戳都不算', () => {
    const [root, clean] = fakeProject({
      'SKILL.md': '# s', 'README.md': '# r', 'CHANGELOG.md': '# c', 'docs/ARCHITECTURE.md': '# a'
    });
    try {
      // 基准取**文件系统时钟**：所有文件建完之后，取它们 mtimeMs 的最大值再加安全余量。
      // 为什么不能用 `Date.now()` 当基准（2026-09-30 实测的真缺陷，偶发假红）：
      //   mtimeMs 是**亚毫秒**精度（NTFS 100 ns），`Date.now()` 只有整毫秒 ⇒ 刚写出来的文件
      //   mtimeMs 可能略大于 now，于是被"未来时间戳不算最近改动"的守卫排除掉，
      //   这个用例偶发红成 `expected ['SKILL.md'] to include 'docs/ARCHITECTURE.md'`。
      //   +1000ms 是安全余量（窗口 10 分钟，加 1 秒不影响"窗口内/外"的判定）。
      // 这是修一条真实发生过的偶发假红，不是放宽标准：
      //   真正的时钟偏移仍由后面"未来 1 小时"那条断言守着，它必须继续被排除。
      const now = maxMtimeMsUnder(root) + 1000;
      // 把其中一份的 mtime 设成 30 分钟前、另一份设成 1 天前
      const old = path.join(root, 'README.md');
      fs.utimesSync(old, new Date(now - 30 * 60000), new Date(now - 30 * 60000));
      const ancient = path.join(root, 'CHANGELOG.md');
      fs.utimesSync(ancient, new Date(now - 86400000), new Date(now - 86400000));
      const recent = recentlyChanged(root, 10, now);
      expect(recent).toContain('SKILL.md');           // 刚建的文件（窗口内）
      expect(recent).toContain('docs/ARCHITECTURE.md');
      expect(recent).not.toContain('README.md');      // 30 分钟前 > 10 分钟窗口
      expect(recent).not.toContain('CHANGELOG.md');   // 1 天前
      // 未来时间戳（时钟偏移）不算"最近改动"——不让它以负数混进窗口
      const future = path.join(root, 'README.md');
      fs.utimesSync(future, new Date(now + 3600000), new Date(now + 3600000));
      expect(recentlyChanged(root, 10, now)).not.toContain('README.md');
    } finally { clean(); }
  });

  it('排除工作产物区与归档族（那些本来就天天在动）', () => {
    const [root, clean] = fakeProject({
      'SKILL.md': '# s', 'README.md': '# r', 'CHANGELOG.md': '# c', 'docs/ARCHITECTURE.md': '# a',
      '.review/20260101-x/notes.md': '# 工作稿', 'docs/archive/OLD.md': '# 旧稿'
    });
    try {
      const recent = recentlyChanged(root, 10, Date.now());
      expect(recent.some((f) => f.startsWith('.review/'))).toBe(false);
      expect(recent.some((f) => f.startsWith('docs/archive/'))).toBe(false);
    } finally { clean(); }
  });
});

describe('docs-registry-check：登记表由文档头部元信息生成（T5）', () => {
  const hdr = (layer, purpose, notWrite, update) => [
    '<!-- registry（数据源）', '层: ' + layer, '作用: ' + purpose,
    '不该写: ' + notWrite, '更新方式: ' + update, '-->', ''
  ].join('\n');
  const MARK = (table) => '<!-- BEGIN:registry-table（勿手改）-->\n\n' + table + '\n<!-- END:registry-table -->';

  it('parseDocHeader：解析四行元信息；**四行缺一即为不合格**（旧实现只强制 层/作用）', () => {
    const ok = checker.parseDocHeader('# t\n\n' + hdr('契约', '命令参考', '架构理由', '手写'));
    expect(ok).toMatchObject({ layer: '契约', purpose: '命令参考', notWrite: '架构理由', update: '手写' });
    expect(checker.parseDocHeader('# t\n\n<!-- registry\n作用: 只有作用\n-->')).toBeNull();
    expect(checker.parseDocHeader('# t\n\n没有元信息')).toBeNull();
    // 新增：有块但缺行 ⇒ 也不合格，且**点名缺哪几行**（报错要说准，别把"缺两行"说成"没有块"）
    const twoKeys = '# t\n\n<!-- registry\n层: 契约\n作用: 只要两行\n-->';
    expect(checker.parseDocHeader(twoKeys)).toBeNull();
    expect(checker.parseHeaderBlock(twoKeys).missing).toEqual(['不该写', '更新方式']);
    expect(checker.REQUIRED_HEADER_KEYS).toEqual(['层', '作用', '不该写', '更新方式']);
  });

  it('checkLayerValues：`层` 必须在取值表内（旧实现只把 LAYER_ORDER 用于排序 ⇒ 非法值无人管）', () => {
    const m = (layer) => ({ rel: 'docs/A.md', meta: { layer, purpose: 'x', notWrite: 'y', update: 'z' } });
    expect(checker.checkLayerValues([m('乱写')]).map((p) => p.kind)).toEqual(['layer']);
    expect(checker.checkLayerValues([m('契约')])).toEqual([]);
    expect(checker.checkLayerValues([{ rel: 'docs/B.md', meta: null, state: 'no-header' }])).toEqual([]);  // 没元信息的不重复报
  });

  it('collectDocHeaders：**递归**扫 docs/ 子目录，但跳过归档族（归档不逐份要求元信息）', () => {
    const [root, clean] = fakeProject({
      'SKILL.md': '# s\n\n' + hdr('入口', 'x', 'y', '手写'),
      'README.md': '# r\n\n' + hdr('入口', 'x', 'y', '手写'),
      'CHANGELOG.md': '# c\n\n' + hdr('记录', 'x', 'y', '手写'),
      'docs/DEEP.md': '# d\n\n' + hdr('设计', 'x', 'y', '手写'),
      'docs/sub/deep.md': '# 子目录里没有元信息\n',
      'docs/archive/OLD.md': '# 归档旧稿（跳过）\n'
    });
    try {
      const entries = checker.collectDocHeaders(root);
      const rels = entries.map((e) => e.rel);
      expect(rels).toContain('docs/sub/deep.md');                       // 旧实现完全看不到它
      expect(entries.find((e) => e.rel === 'docs/sub/deep.md').state).toBe('no-header');
      expect(rels).not.toContain('docs/archive/OLD.md');                // 归档族被跳过
      expect(entries.every((e) => typeof e.state === 'string')).toBe(true);   // 每份都带判定状态
    } finally { clean(); }
  });

  it('受管文档在磁盘上不存在 ⇒ state=missing（报错说"文件不存在"，不误报成"缺元信息块"）', () => {
    const [root, clean] = fakeProject({ 'README.md': '# r\n\n' + hdr('入口', 'x', 'y', '手写') });
    try {
      const entries = checker.collectDocHeaders(root);
      expect(entries.find((e) => e.rel === 'SKILL.md').state).toBe('missing');
      expect(checker.headerProblemLine(entries.find((e) => e.rel === 'SKILL.md'))).toContain('不存在');
      expect(checker.headerProblemLine({ rel: 'x', state: 'partial', gaps: ['不该写'] })).toContain('缺 不该写');
    } finally { clean(); }
  });

  it('生成模式与检查模式一致：有不合格文档时 writeRegistryTable 必须拒绝（返回 false）', () => {
    const [root, clean] = fakeProject({
      'SKILL.md': '# s\n\n' + hdr('入口', 'x', 'y', '手写'),
      'docs/ARCHITECTURE.md': '# a\n\n' + hdr('设计', 'x', 'y', '手写'),
      'docs/BAD.md': '# 两行元信息\n\n<!-- registry\n层: 治理\n作用: 只有两行\n-->\n'
    });
    try {
      expect(checker.writeRegistryTable(root)).toBe(false);             // 拒绝生成（旧实现会写默认值放过）
    } finally { clean(); }
  });

  it('renderRegistryTable：按层排序，且归档族由两行前缀覆盖（不需要逐份声明）', () => {
    const table = checker.renderRegistryTable([
      { rel: 'docs/B.md', meta: { layer: '契约', purpose: 'B', notWrite: '—', update: '手写' } },
      { rel: 'docs/A.md', meta: { layer: '入口', purpose: 'A', notWrite: '—', update: '手写' } }
    ]);
    const lines = table.split('\n');
    expect(lines[0]).toContain('| 层 | 文档 |');
    expect(lines[2]).toContain('`docs/A.md`');          // 入口在前
    expect(lines[3]).toContain('`docs/B.md`');
    expect(table).toContain('`docs/archive/*`');
    expect(table).toContain('`docs/changelog/*`');
  });

  it('登记表与元信息不一致 ⇒ registry-stale（手改表格 / 改元信息不重生成）', () => {
    const files = {
      'SKILL.md': '# s\n\n' + hdr('入口', '触发与导航', '规则全表', '手写'),
      'README.md': '# r\n\n' + hdr('入口', '产品门面', '模块表', '手写'),
      'CHANGELOG.md': '# c\n\n' + hdr('记录', '变更轨迹', '—', '每次变更必写'),
      // ARCHITECTURE.md 自己也是受管文档（docs/*.md），也要有元信息块
      'docs/ARCHITECTURE.md': '# a\n\n' + hdr('设计', '分层决策', '具体数字', '手写')
    };
    const entries = Object.keys(files).map((rel) => ({ rel, meta: checker.parseDocHeader(files[rel]) }));
    const good = MARK(checker.renderRegistryTable(entries));
    const [root, clean] = fakeProject(Object.assign({}, files, {
      'docs/ARCHITECTURE.md': '# a\n\n' + hdr('设计', '分层决策', '具体数字', '手写') + '\n## 5. 文档架构\n\n' + good + '\n'
    }));
    try {
      const md = fs.readFileSync(path.join(root, 'docs', 'ARCHITECTURE.md'), 'utf8');
      expect(checker.checkRegistryTable(root, md)).toEqual([]);
      // 手改表格里的一行 ⇒ 必须报
      const tampered = md.replace('产品门面', '产品门面（手改）');
      const hits = checker.checkRegistryTable(root, tampered);
      expect(hits.some((h) => h.kind === 'registry-stale')).toBe(true);
    } finally { clean(); }
  });

  it('文档缺元信息块 ⇒ no-header（并提示跑 docs:registry）', () => {
    const [root, clean] = fakeProject({
      'SKILL.md': '# s\n\n' + hdr('入口', 'x', 'y', '手写'),
      'README.md': '# r（没有元信息块）', 'CHANGELOG.md': '# c\n\n' + hdr('记录', 'z', '—', '每次变更必写'),
      'docs/ARCHITECTURE.md': '# a\n\n## 5. 文档架构\n\n' + MARK('| 层 | 文档 |\n|---|---|\n')
    });
    try {
      const md = fs.readFileSync(path.join(root, 'docs', 'ARCHITECTURE.md'), 'utf8');
      const hits = checker.checkRegistryTable(root, md);
      expect(hits.find((h) => h.kind === 'no-header').rel).toBe('README.md');
    } finally { clean(); }
  });

  it('未采用元信息的工程（如旧工程/单测 fixture）⇒ 不判，避免把无关工程变红', () => {
    const [root, clean] = fakeProject({
      'SKILL.md': '# s', 'README.md': '# r', 'CHANGELOG.md': '# c', 'docs/ARCHITECTURE.md': '# a'
    });
    try {
      const md = fs.readFileSync(path.join(root, 'docs', 'ARCHITECTURE.md'), 'utf8');
      expect(checker.checkRegistryTable(root, md)).toEqual([]);
    } finally { clean(); }
  });
});

describe('docs-registry-check：真实工程合规（回归守护）', () => {
  it('本工程无表外文档 / 散落文档 / 悬挂登记 / 交接死指针 / 未入档代码 / 缺横幅归档 / 无状态工作目录 / 契约缺字段 / 断号', () => {
    const md = fs.readFileSync(path.join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8');
    const { problems, reg } = checkRegistry(ROOT, md);
    expect(reg.found).toBe(true);                                 // §5 段必须存在
    expect(reg.exact.size).toBeGreaterThanOrEqual(10);            // 解析不能"抽空"
    expect(problems.map((p) => '[' + p.kind + '] ' + p.rel + ' ' + p.msg)).toEqual([]);
  });
});
