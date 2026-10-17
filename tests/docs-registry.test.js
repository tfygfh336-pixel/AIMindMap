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

/** 造一段"头部元信息块"（四行齐备）。**放模块作用域**：`fakeProject` 的默认 `docs/EXTENSIONS.md`
 *  在**模块加载期**就要用它（原先它定义在某个 describe 内部 ⇒ 模块级常量取不到它 ⇒ 整个测试
 *  文件在加载期抛 ReferenceError、49 条用例一条都不跑 —— 而报告的只是"suite 失败"，
 *  极容易看成"某个用例红了" ✗ 实测踩到） */
const hdr = (layer, purpose, notWrite, update) => [
  '<!-- registry（数据源）', '层: ' + layer, '作用: ' + purpose,
  '不该写: ' + notWrite, '更新方式: ' + update, '-->', ''
].join('\n');
/** 登记表标记（BEGIN/END）包裹一段表格 */
const MARK = (table) => '<!-- BEGIN:registry-table（勿手改）-->\n\n' + table + '\n<!-- END:registry-table -->';

/** 假工程默认带的 `docs/EXTENSIONS.md`（含 §1.2 稳定性三级表 + 齐备的头部元信息块 —— 它也是受管文档）。
 *  ⚠️ **默认必须带它**：G8 的第 ⑮ 条判定要求"注册表的每条命令都落在某一级里"，而它**无条件跑**
 *     （适用条件不得由被检对象决定：文档缺了就判红，不是跳过）。真值取自本工程真实注册表，
 *     所以这份默认表要覆盖它（只列 `read`/`list`）—— 要验"漏登记"的用例自己传 `namesIn` ✓。
 *  ⚠️ 元信息块要**四行齐备**：否则 `checkRegistryTable` 会报 no-header/partial（与本用例无关的红）。 */
const EXT_HEADER = hdr('契约', '扩展契约', 'CLI 全量签名', '手写');
/** 稳定性三级表的**正文**（不含头部元信息块）—— 复用给两个地方：默认 fixture 与需要
 *  "自己拼一份 EXTENSIONS.md"的用例（避免同一张表在测试里写两份、然后各自漂移 ✗） */
const EXT_TABLE_BODY = [
  '',
  '### 1.2 CLI 命令（稳定的自动化入口）',
  '',
  '| 级别 | 含义 | 命令 |',
  '|------|------|------|',
  '| **稳定** | 不变 | `read`/`list` |',
  ''
].join('\n');
const EXT_DEFAULT = [
  '# 扩展契约（EXTENSIONS）',
  '',
  EXT_HEADER,
  EXT_TABLE_BODY
].join('\n');

/** 造一个假工程，返回 [根目录, 清理函数]（模块级：多个 describe 共用）。
 *  ⚠️ **默认带一份 `docs/EXTENSIONS.md`**（含 §1.2 稳定性三级表 + 齐备的头部元信息块）：G8 的
 *     第 ⑮ 条判定（稳定性表必须覆盖注册表里的每条命令）**无条件跑**（适用条件不得由被检对象决定：
 *     文档缺了就判红，不是跳过）⇒ 不带它的话，凡断言"零问题"的用例都会多出一条与本用例无关的红 ✗。
 *     默认表要能覆盖真实注册表 —— 它只列 `read`/`list`；要验"漏登记"的用例自己传 `namesIn` ✓。 */
function fakeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-docs-registry-'));
  const all = Object.assign({ 'docs/EXTENSIONS.md': EXT_DEFAULT }, files);
  Object.entries(all).forEach(([rel, body]) => {
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
    // ⚠️ 这份 fixture 里**每份受管文档**都要有齐备的头部元信息块（含默认带的 `docs/EXTENSIONS.md`），
    //    且 §5 登记表要覆盖它们的路径 —— 否则"零问题"这条断言会撞上**与本用例无关**的红
    const files = {
      // SKILL.md 必须提到 §5 登记的每份文档（导航可达判定 checkNavCoverage），**含它自己**
      'SKILL.md': '# s（本文件即 `SKILL.md`）\n\n' + hdr('入口', '触发与导航', '规则全表', '手写')
        + '\n- 入口：`README.md` / `CHANGELOG.md`\n'
        + '- 架构：`docs/ARCHITECTURE.md`\n- 扩展：`docs/EXTENSIONS.md`\n',
      'README.md': '# r\n\n' + hdr('入口', '产品门面', '模块表', '手写'),
      'CHANGELOG.md': '# c\n\n' + hdr('记录', '变更轨迹', '—', '每次变更必写'),
      'docs/ARCHITECTURE.md': '# a\n\n' + hdr('设计', '分层决策', '具体数字', '手写'),
      'docs/EXTENSIONS.md': '# e\n\n' + EXT_HEADER + EXT_TABLE_BODY,
      'renderer/index.html': '<html></html>',
      'docs/archive/OLD-2020.html': '<!DOCTYPE html>\n<!-- 历史归档：勿作现状引用 -->\n<html></html>',
      'docs/changelog/v0.1.0.md': '> 历史归档（滚动归档）：勿作现状引用\n\n# 滚动归档的历史版本段',
      'docs/changelog/v0.2.0.md': '> 历史归档（滚动归档）：勿作现状引用\n\n# 同上'
    };
    const [root, clean] = fakeProject(files);
    try {
      const table = MARK([
        '| 层 | 文档 | 作用 |',
        '|----|------|------|',
        '| 入口 | `SKILL.md` | 触发与导航 |',
        '| 入口 | `README.md` | 产品门面 |',
        '| 记录 | `CHANGELOG.md` | 变更轨迹 |',
        '| 设计 | `docs/ARCHITECTURE.md` | 分层决策 |',
        '| 契约 | `docs/EXTENSIONS.md` | 扩展契约 |',
        '| 归档 | `docs/archive/*` | 历史快照 |'
      ].join('\n'));
      fs.writeFileSync(path.join(root, 'docs', 'ARCHITECTURE.md'),
        '# a\n\n' + hdr('设计', '分层决策', '具体数字', '手写') + '\n## 5. 文档架构\n\n' + table + '\n', 'utf8');
      // §5 登记表要覆盖 EXTENSIONS.md（否则"表外文档"那条会红 —— 与本用例要验的东西无关）
      const md = fakeRegistry().replace('| 设计 | `docs/ARCHITECTURE.md` | 分层决策 |',
        '| 设计 | `docs/ARCHITECTURE.md` | 分层决策 |\n| 契约 | `docs/EXTENSIONS.md` | 扩展契约 |');
      const { problems } = checkRegistry(root, md);
      // ⚠️ 排除两条**与本用例无关**的判定（它们是默认 fixture 的副作用，不是"合规工程"的问题）：
      //    · `stability`：稳定性表覆盖的真值是**本工程真实注册表**（54 条命令），而这份 fixture 的
      //      稳定性表只列几条 —— 那是另一个 describe（「CLI 稳定性表覆盖」）负责的事；
      //    · `registry` / `registry-stale`：§5 登记表是否存在/是否与文档元信息逐字一致 ——
      //      那是下一个用例（「登记表与元信息不一致 ⇒ registry-stale」）负责的事。
      expect(problems.filter((p) => ['stability', 'registry', 'registry-stale'].indexOf(p.kind) < 0)
        .map((p) => p.kind + ' ' + p.rel + ' ' + p.msg)).toEqual([]);
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

  /* 下面两条是**移位不变**的常驻证明（对应 `.review/20261016-T5-G8豁免/` 的一次性读数）。
   * 为什么必须常驻：判定的旧实现只扫顶层 ⇒ 豁免是"非递归"这个**副作用**。谁哪天把递归改回去
   * （或把子目录判断改回文件名口径），一次性读数不会说话，这两条会红。 */
  it('子目录里的**同名**文件不算已登记 → module-cover（换目录不能沿用顶层那条登记）', () => {
    const [root, clean] = fakeProject(Object.assign({}, base, {
      'src/known.js': '// 文档里登记过 `known.js`',
      'scripts/tools/known.js': '// 同名，只换了目录 —— 文档里没有 scripts/tools/known.js'
    }));
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      const rels = problems.filter((p) => p.kind === 'module-cover').map((p) => p.rel);
      expect(rels).toEqual(['scripts/tools/known.js']);
    } finally { clean(); }
  });

  it('子目录文件按**完整相对路径**登记即通过（豁免不是唯一出路）', () => {
    const [root, clean] = fakeProject(Object.assign({}, base, {
      'docs/ARCHITECTURE.md': '# 架构\n\n| `known.js` | 已有模块 |\n'
        + '| `scripts/tools/helper.js` | 子目录里按完整路径登记 |\n',
      'src/known.js': '// ok',
      'scripts/tools/helper.js': '// 已按路径登记'
    }));
    try {
      const { problems } = checkRegistry(root, fakeRegistry());
      expect(problems.filter((p) => p.kind === 'module-cover')).toEqual([]);
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
  // `hdr` / `MARK` 在模块作用域（见文件上方的说明：默认 fixture 在加载期就要用它们）

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
      // ⚠️ 覆盖掉默认 fixture 带的那份 EXTENSIONS.md（空内容 = "没有元信息块"）：
      //    本用例比的是"表与**这几份**文档的元信息是否逐字一致"，多一份带元信息的文档
      //    会让期望表与磁盘表都对不上（那是与本用例无关的红 ✗）
      'docs/EXTENSIONS.md': '',
      'docs/ARCHITECTURE.md': '# a\n\n' + hdr('设计', '分层决策', '具体数字', '手写') + '\n## 5. 文档架构\n\n' + good + '\n'
    }));
    try {
      const md = fs.readFileSync(path.join(root, 'docs', 'ARCHITECTURE.md'), 'utf8');
      // ⚠️ 显式只把**本用例造的那几份**交给判定：`collectDocHeaders` 会把默认 fixture 里的
      //    `docs/EXTENSIONS.md` 也收进来（它没元信息块 ⇒ 报 no-header，与本用例无关的红 ✗）
      const only = (txt) => ({ rel: txt.rel, meta: txt.meta, state: txt.state });
      const mine = checker.collectDocHeaders(root).filter((e) => e.rel !== 'docs/EXTENSIONS.md').map(only);
      expect(checker.checkRegistryTable(root, md, mine)).toEqual([]);
      // 手改表格里的一行 ⇒ 必须报
      const tampered = md.replace('产品门面', '产品门面（手改）');
      const hits = checker.checkRegistryTable(root, tampered, mine);
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
      'SKILL.md': '# s', 'README.md': '# r', 'CHANGELOG.md': '# c', 'docs/ARCHITECTURE.md': '# a',
      'docs/EXTENSIONS.md': ''    // 也覆盖掉默认那份（本用例要的是"整个工程都没有元信息块"）
    });
    try {
      const md = fs.readFileSync(path.join(root, 'docs', 'ARCHITECTURE.md'), 'utf8');
      expect(checker.checkRegistryTable(root, md)).toEqual([]);
    } finally { clean(); }
  });
});

describe('docs-registry-check：CLI 稳定性表覆盖（G8 第 ⑮ 条判定）', () => {
  /** 造一份最小 EXTENSIONS.md（三级表 + 表外说明文字，用来验"只认表格行"） */
  function fakeExt(commands) {
    return [
      '# 扩展契约（EXTENSIONS）',
      '',
      '## 1. 可依赖的稳定接口',
      '',
      '### 1.1 数据格式（最稳定）',
      '',
      '外部工具应直接读 JSON 文件。',
      '',
      '### 1.2 CLI 命令（稳定的自动化入口）',
      '',
      '稳定性分三级：',
      '',
      '| 级别 | 含义 | 命令 |',
      '|------|------|------|',
      '| **稳定** | 不变 | 数据读写类：`read`/`list` |',
      '| **演进中** | 可增补 | ' + commands.map((c) => '`' + c + '`').join('/') + ' |',
      '| **内部** | 不保证 | `release` |',
      '',
      '> 说明：`read` 这条命令很常用 —— 引用块里的名字**不算登记**（否则漏登记会被掩盖 ✗）。',
      '',
      '### 1.3 MCP 工具',
      '',
      '每个 MCP 工具都是某个 CLI 命令的透传。',
      ''
    ].join('\n');
  }

  it('parseStabilityTable：只认表格行里的反引号名，说明词/引用块/非命令名（`.md`、带空格）都不算', () => {
    const t = checker.parseStabilityTable(fakeExt(['import-md', 'import-project']));
    expect(t).not.toBe(null);
    expect([...t.cmds].sort()).toEqual(['import-md', 'import-project', 'list', 'read', 'release']);
    expect(t.cmds.has('说明')).toBe(false);
    // ⚠️ 这条正是踩过的坑：行内既有说明词又有命令名时，靠"切分"会把名字切坏/粘上说明词 ⇒ 假红。
    //    这里直接给一份"说明词紧贴命令名"的段，判据必须**逐个反引号匹配**才过得去。
    const glued = [
      '### 1.2 CLI 命令（稳定的自动化入口）',
      '',
      '| 级别 | 含义 | 命令 |',
      '|------|------|------|',
      '| **稳定** | 不变 | 数据读写类：`read`/`list`/`get` |',
      '',
      '### 1.3 MCP 工具',
      ''
    ].join('\n');
    expect([...checker.parseStabilityTable(glued).cmds].sort()).toEqual(['get', 'list', 'read']);
    // `</br>` 之类的 HTML 片段会混进同一格 ⇒ 不许把命令名切坏（实测切坏过 backlinks / ask-apply）
    const brk = glued.replace('数据读写类：`read`/`list`/`get`', '树：`backlinks`/`ask-apply`</br>界面：`ui-state`/`dsh-caps`');
    expect([...checker.parseStabilityTable(brk).cmds].sort())
      .toEqual(['ask-apply', 'backlinks', 'dsh-caps', 'ui-state']);
    // 段不存在 ⇒ null（调用方据此判红，而不是当成"全都登记了"）
    expect(checker.parseStabilityTable('# 没有 1.2 节')).toBe(null);
  });

  it('★ 判别力注入：注册表里有一条命令没落进任何一级 ⇒ 必红，且报文点名是哪条', () => {
    const [root, clean] = fakeProject({
      'SKILL.md': '# s', 'README.md': '# r', 'CHANGELOG.md': '# c',
      'docs/ARCHITECTURE.md': fakeRegistry(),
      'docs/EXTENSIONS.md': fakeExt(['import-md'])       // ← 表里只登记 import-md / read / list / release
    });
    try {
      // 真值清单用**注入**的方式给（假工程里没有真注册表；生产路径不传 ⇒ 现场读
      // 本工程的 registry.js，见 checkStabilityCoverage 的第二个参数）
      const problems = checker.checkStabilityCoverage(root, ['read', 'list', 'release', 'import-md', 'import-project']);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems[0].kind).toBe('stability');
      expect(problems[0].rel).toBe('docs/EXTENSIONS.md');
      expect(problems[0].msg).toContain('漏登记');
      expect(problems[0].msg).toContain('import-project');   // 必须**点名**，否则不知道去补哪条
    } finally { clean(); }
  });

  it('★ 采不到真值必红：命令真值清单为空时不许静默通过（"没有命令要覆盖"是假象）', () => {
    const [root, clean] = fakeProject({
      'SKILL.md': '# s', 'README.md': '# r', 'CHANGELOG.md': '# c',
      'docs/ARCHITECTURE.md': fakeRegistry(),
      'docs/EXTENSIONS.md': fakeExt(['a', 'b'])
    });
    try {
      const problems = checker.checkStabilityCoverage(root, []);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems[0].msg).toContain('一条命令都没有');
    } finally { clean(); }
  });

  it('表被删/改成别的写法 ⇒ 报"一条都没解析到"（不静默通过）', () => {
    const [root, clean] = fakeProject({
      'SKILL.md': '# s', 'README.md': '# r', 'CHANGELOG.md': '# c',
      'docs/ARCHITECTURE.md': fakeRegistry(),
      'docs/EXTENSIONS.md': '# 扩展契约\n\n## 1. 可依赖的稳定接口\n\n### 1.2 CPU 调度\n\n没有表\n'
    });
    try {
      const problems = checker.checkStabilityCoverage(root, ['read']);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems[0].msg).toContain('都没解析到');
    } finally { clean(); }
  });

  it('全覆盖即通过（判据是"覆盖"，不判"放哪一级" —— 那是人的判断）', () => {
    const [root, clean] = fakeProject({
      'SKILL.md': '# s', 'README.md': '# r', 'CHANGELOG.md': '# c',
      'docs/ARCHITECTURE.md': fakeRegistry(),
      'docs/EXTENSIONS.md': fakeExt(['alpha', 'beta'])
    });
    try {
      expect(checker.checkStabilityCoverage(root, ['read', 'list', 'release', 'alpha', 'beta'])).toEqual([]);
    } finally { clean(); }
  });

  it('真实工程：本工程的三级表覆盖了注册表里的全部命令（少了任何一条，npm test 就会红）', () => {
    const problems = checker.checkStabilityCoverage(ROOT);
    expect(problems.map((p) => p.kind + ' ' + p.msg)).toEqual([]);
  });
});

describe('docs-registry-check：整行重复（G8 第 ⑯ 条判定）', () => {
  /** 真实事故的形状：`137ab3e` 把同一条表格行**连着写了两遍**（它是被"还原 + 登记"两步叠加写出来的）。
   *  下面这份 fixture 就是那个形状的最小复现（相邻两行逐字节相同）。 */
  const DUP_ROW = '| `path-chain.js` | **「路径 → 打开 / 预览」的判据 —— 唯一实现**（三段式） | `src/path-chain.js` |';
  const table = (rows) => ['| 模块 | 作用 | 路径 |', '|------|------|------|'].concat(rows).join('\n');

  it('tableDataRows：表头（紧跟分隔行 / 块首行）与分隔行都不算数据行；行号是 1 基', () => {
    const md = [
      '| 字段 | 必填 |',       // 1 表头（块首行 + 紧跟分隔行）
      '|------|------|',       // 2 分隔行
      '| a | 是 |',            // 3 数据行
      '| b | 否 |',            // 4 数据行
      '',
      '| 名字 | 值 |',         // 6 表头（块首行；本块**没有分隔行** —— 受管 .md 里实测有 6 个这样的块）
      '| x | 1 |'              // 7 数据行
    ].join('\n');
    const m = checker.tableDataRows(md);
    expect([...m.keys()].sort()).toEqual(['| a | 是 |', '| b | 否 |', '| x | 1 |']);
    expect(m.get('| a | 是 |')).toEqual([3]);
    expect(m.get('| x | 1 |')).toEqual([7]);          // 只认"紧跟分隔行"会漏掉它的表头 ⇒ 这里靠"块首行"兜住
  });

  it('★ 判别力注入：同一条表格数据行写了两遍（相邻，真实事故的形状）⇒ 必红且点出两个行号', () => {
    const [root, clean] = fakeProject({ 'docs/DUP.md': table([DUP_ROW, DUP_ROW]) });
    try {
      const r = checker.checkDuplicateRows(root, ['docs/DUP.md'], []);
      expect(r.problems.length).toBe(1);
      expect(r.problems[0].kind).toBe('dup-row');
      expect(r.problems[0].msg).toMatch(/docs\/DUP\.md:3/);
      expect(r.problems[0].msg).toMatch(/docs\/DUP\.md:4/);
      expect(r.stats.groups).toBe(1);
      // 对照：只留一份 ⇒ 不红（证明判的是"重复"，不是"有表格"）
      const [root2, clean2] = fakeProject({ 'docs/DUP.md': table([DUP_ROW]) });
      try {
        expect(checker.checkDuplicateRows(root2, ['docs/DUP.md'], []).problems).toEqual([]);
      } finally { clean2(); }
    } finally { clean(); }
  });

  it('★ 跨文档重复同样必红（"一份事实只写一处"：两份文档各写一遍也是多副本）', () => {
    const [root, clean] = fakeProject({
      'docs/A.md': table([DUP_ROW]), 'docs/B.md': table([DUP_ROW])
    });
    try {
      const r = checker.checkDuplicateRows(root, ['docs/A.md', 'docs/B.md'], []);
      expect(r.problems.length).toBe(1);
      expect(r.problems[0].msg).toMatch(/docs\/A\.md:3/);
      expect(r.problems[0].msg).toMatch(/docs\/B\.md:3/);
    } finally { clean(); }
  });

  it('★ 正当重复**不判红**（第三种答案）：分隔行 / 表头行重复、正文重复都是结构性的', () => {
    // 为什么这条必须有：一个只会说"对/错"两档的判据，会把"有意重复"判成真缺陷（skill B4b / H3b）。
    // 受管 .md 上实测 47 组"任意行重复"**全是正当重复** ⇒ 判据形态若选"任意行"就是必然假红。
    const md = [
      '| 字段 | 必填 |', '|------|------|', '| a | 是 |', '',
      '| 字段 | 必填 |', '|------|------|', '| b | 否 |', '',   // 表头重复 + 分隔行重复
      '#### 六、未做 / 未核实（诚实清单）', '',
      '#### 六、未做 / 未核实（诚实清单）', '',                    // 历史小标题重复（CHANGELOG 实测就是这个形状）
      '> ⚠️ **历史快照，已归档 —— 请勿作为现状引用。**', '',
      '> ⚠️ **历史快照，已归档 —— 请勿作为现状引用。**', ''
    ].join('\n');
    const [root, clean] = fakeProject({ 'docs/OK.md': md });
    try {
      const r = checker.checkDuplicateRows(root, ['docs/OK.md'], []);
      expect(r.problems).toEqual([]);
      expect(r.stats.rows).toBe(2);      // 只数到了两条数据行 ⇒ 表头/分隔行确实被结构性排除
    } finally { clean(); }
  });

  it('工作产物区（.review/）整片不扫：那里是分析稿，扫它会让"只写工作区"的任务永远不可能变绿', () => {
    const [root, clean] = fakeProject({
      'docs/A.md': table([DUP_ROW]),
      '.review/probe/README.md': table([DUP_ROW])          // 同一行在工作产物区里也有一份
    });
    try {
      // 即便把 .review 传进扫描面，它也必须被过滤掉
      const r = checker.checkDuplicateRows(root, ['docs/A.md', '.review/probe/README.md'], []);
      expect(r.problems).toEqual([]);
      expect(r.stats.files).toBe(1);
    } finally { clean(); }
  });

  it('豁免册是**封闭册**：在册且仍成立的豁免不判红；修好忘销账 / 缺 why / 超上界各自判红', () => {
    const [root, clean] = fakeProject({ 'docs/DUP.md': table([DUP_ROW, DUP_ROW]) });
    try {
      const line = DUP_ROW;
      // ① 在册 + 有 why + 未超上界 ⇒ 不判红（豁免允许，但必须登记在门禁侧并写原因）
      //    ⚠️ 上界走**依赖注入**：本工程的上界现值是 0（零存量违例），不为单测去动那个数。
      const ok = checker.checkDuplicateRows(root, ['docs/DUP.md'],
        [{ rel: 'docs/DUP.md', line, why: '单测：正当重复的演示条目' }], 1);
      expect(ok.problems).toEqual([]);
      expect(ok.stats.exempt).toBe(1);
      // ② 册上那条已经不再成立（重复被修好了却没销账）⇒ 必红（逼人销账）
      const [root2, clean2] = fakeProject({ 'docs/DUP.md': table([DUP_ROW]) });
      try {
        const stale = checker.checkDuplicateRows(root2, ['docs/DUP.md'],
          [{ rel: 'docs/DUP.md', line, why: '已修好但忘销账' }], 1);
        expect(stale.problems.map((p) => p.kind)).toEqual(['dup-exempt']);
        expect(stale.problems[0].msg).toMatch(/不再成立|销账/);
      } finally { clean2(); }
      // ③ 没有 why 的豁免 = 把判据关掉 ⇒ 必红
      const noWhy = checker.checkDuplicateRows(root, ['docs/DUP.md'], [{ rel: 'docs/DUP.md', line }], 1);
      expect(noWhy.problems.map((p) => p.kind)).toContain('dup-exempt');
      expect(noWhy.problems.map((p) => p.msg).join('\n')).toMatch(/没写 `why`/);
      // ④ 条数超过上界 ⇒ 必红（只减不增）
      const over = checker.checkDuplicateRows(root, ['docs/DUP.md'],
        [{ rel: 'docs/DUP.md', line, why: 'a' }, { rel: 'docs/DUP.md', line, why: 'b' }], 1);
      expect(over.problems.map((p) => p.kind)).toContain('dup-exempt');
      expect(over.problems.map((p) => p.msg).join('\n')).toMatch(/只减不增/);
      // ⑤ 生产用的上界现值：0 条（本工程零存量违例 ⇒ 新出现一处重复就必须改文，不许加豁免）
      expect(checker.DUP_ROW_EXEMPT_MAX).toBe(0);
    } finally { clean(); }
  });

  it('真实工程：受管 .md 的表格数据行没有逐字节重复（本判定的回归守护 + 在册豁免不超上界）', () => {
    const r = checker.checkDuplicateRows(ROOT);
    expect(r.problems).toEqual([]);
    expect(r.stats.files).toBeGreaterThan(20);
    expect(r.stats.rows).toBeGreaterThan(300);              // 分母不是 0 ⇒ 判据真的扫到了东西
    expect(checker.DUP_ROW_EXEMPT.length).toBeLessThanOrEqual(checker.DUP_ROW_EXEMPT_MAX);
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
