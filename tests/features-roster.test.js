/* ============================================================
 * tests/features-roster.test.js — `features` 命令纯逻辑单测（vitest）
 * ------------------------------------------------------------
 * 覆盖 `src/features-roster.js` 的**每一条判据**（这是本命令的技术核心，必须能被单测直接引入）：
 *   A. 名册表的**解析**：7 列 / `\|` 转义竖线 / 分隔行 / 结构性判定（缺节、缺表头、列错位、代号重名）
 *   B. **承接提及**的名字边界：七种"形似命令却不是那个命令"的写法一个都不许命中
 *   C. **调用形态**候选：`node cli/mm-cli.js …` / 单词 span / `xxx.html` / `tag-*` 都不是候选
 *   D. 两个差集：`docOnly`（文档有、registry 没有）与 `unmentioned`（registry 有、文档没提）
 *   E. 三处联合检索的**判别力**：同一个功能的命令名与中文名**都**能找到它（`GAP-4` 的反面）
 *   F. 确定性：同一份输入两跑结果逐字节相同（`--json` 的"两跑 sha256 相同"就靠它）
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import roster from '../src/features-roster.js';

// ESM 下没有 `require` / `__dirname`：真值（registry 的 78 条命令）要**现场**取，
// 不在测试里抄一份清单（抄一份就是第二份副本，迟早漂移）。
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_MD = fs.readFileSync(path.join(ROOT, 'docs', 'FEATURES.md'), 'utf8');

/** 现场把 registry 折成 `buildModel` 要的形状（正式名 + 别名→正式名） */
function registryShape() {
  const list = require('../cli/registry.js').list();
  return {
    names: list.map((c) => c.name),
    aliases: list.reduce((acc, c) => { (c.aliases || []).forEach((a) => { acc[a] = c.name; }); return acc; }, {})
  };
}

/* ---------------- 夹具：造一份最小名册 ----------------
 * 表头/分隔行照真实文档的形状写；`rows` 逐条给 7 格。 */
const HEAD = '| 代号 | 中文名 | 一句话 | 承载（命令 / 门禁 / 域 / 模块） | 实现状态 | 为什么这么叫 | 备注 |';
const SEP = '|------|--------|--------|------------------------------|---------|-------------|------|';
function row(cells) { return '| ' + cells.join(' | ') + ' |'; }
function fixtureDoc(rows, opts) {
  const o = opts || {};
  const lines = ['# 产品功能名册', ''];
  if (o.section !== null) lines.push(o.section || '## 3. 名册（唯一权威表）', '');
  if (o.head !== null) lines.push(o.head || HEAD, SEP);
  rows.forEach((r) => lines.push(r));
  lines.push('');
  return lines.join('\n');
}
function mkRow(code, name, carrier, status, note) {
  return row([code, name, '一句话', carrier, status || '已实现', '为什么', note || '']);
}

describe('A 名册表的解析（形状与结构性判定）', () => {
  /* ⚠️ 行数在这里写死是**有意的**：新增一行功能就是一次**可见的动作**，必须同批改这里
   * （与 `G-11` 的 GOLDEN 字面量同一条纪律：让"名册变长"不能悄悄发生）。
   * 2026-10-21：`W15` 落了 `IG`（导入分档，`import-grade`）⇒ 16 → 17。 */
  it('A1 真实文档：§3 有 7 列、17 行，代号与中文名两两不重复', () => {
    const p = roster.parseRoster(REAL_MD);
    expect(p.ok).toBe(true);
    expect(p.columns.length).toBe(7);
    expect(p.rows.length).toBe(17);
    expect(p.columns[0]).toBe('代号');
    expect(p.columns[4]).toBe('实现状态');
    const codes = p.rows.map((r) => r.code);
    const names = p.rows.map((r) => r.name);
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(names).size).toBe(names.length);
  });

  /* ⚠️ 这条钉的是**真实文档**那一行，所以状态一改就得同批改这里 —— 它的价值就在"不让名册状态悄悄漂"。
   * 2026-10-20：`W11 a–e` 的 `b「允许完整编辑」`兑现（`renderer/editor.js` 重构成两窗共用的模块，
   * 草稿页真能改标题/正文/加/删/移）⇒ `DM` 的状态从「未实现（部分）」改成「已实现」。
   * 同批把 `docs/FEATURES.md` 那一行、冒烟域 56、`tests/editor-reuse.test.js` 一起落地。 */
  it('A2 真实文档：`DM` 这一行读到的是「草稿图 / 已实现 / W11」（代号↔中文名↔台账三者对得上）', () => {
    const p = roster.parseRoster(REAL_MD);
    const dm = p.rows.filter((r) => r.code === 'DM')[0];
    expect(dm).toBeTruthy();
    expect(dm.name).toBe('草稿图');
    expect(dm.status).toBe('已实现');
    expect(dm.ledger).toBe('W11');
    expect(dm.line).toBeGreaterThan(p.headerLine);
  });

  it('A3 `\\|` 转义竖线**不算列分隔符**：`AP` 行的 `[--mode note\\|related]` 不能把整行切错列', () => {
    const p = roster.parseRoster(REAL_MD);
    const ap = p.rows.filter((r) => r.code === 'AP')[0];
    expect(ap).toBeTruthy();
    expect(ap.cells.length).toBe(7);
    // 承载列里那句 `[--mode note\|related]` 必须**留在承载列里**（切错列时它会跑到状态列）
    expect(ap.carrier.indexOf('note\\|related')).toBeGreaterThanOrEqual(0);
    expect(ap.status).toBe('未实现（部分）');            // 状态列读的是第 5 列，不是承载列的后半截
  });

  it('A4 splitCells：转义竖线留在同一格，普通竖线才切', () => {
    expect(roster.splitCells('| a | b \\| c | d |')).toEqual(['a', 'b \\| c', 'd']);
  });

  it('A5 找不到 `## 3.` 这一节 ⇒ ok:false（名册是名字的唯一同现处，没有它就没有真值）', () => {
    const p = roster.parseRoster(fixtureDoc([mkRow('XX', '某功能', '`x`')], { section: null }));
    expect(p.ok).toBe(false);
    expect(p.problems.join()).toMatch(/## 3\./);
  });

  it('A6 找不到以「代号」开头的表头 ⇒ ok:false（表被删/被改写时不许出空名册）', () => {
    const p = roster.parseRoster(fixtureDoc([mkRow('XX', '某功能', '`x`')], { head: null }));
    expect(p.ok).toBe(false);
    expect(p.problems.join()).toMatch(/表头/);
  });

  it('A7 某行列数与表头不等 ⇒ ok:false 并点名行号（列错位会让"状态"静默读到别的列）', () => {
    const bad = row(['XX', '某功能', '一句话', '`x`', '已实现', '为什么', '备注', '多出来的一格']);
    const p = roster.parseRoster(fixtureDoc([bad]));
    expect(p.ok).toBe(false);
    expect(p.problems.join()).toMatch(/L\d+/);
    expect(p.problems.join()).toMatch(/格/);
  });

  it('A8 代号重名 ⇒ ok:false（代号是"机器指一件事"的锚，重名即歧义）', () => {
    const p = roster.parseRoster(fixtureDoc([
      mkRow('XX', '甲功能', '`a`'), mkRow('XX', '乙功能', '`b`')
    ]));
    expect(p.ok).toBe(false);
    expect(p.problems.join()).toMatch(/代号重复/);
  });

  it('A9 中文名重名 ⇒ ok:false（§2 第 2 条：彼此必须可区分）', () => {
    const p = roster.parseRoster(fixtureDoc([
      mkRow('XX', '同名', '`a`'), mkRow('YY', '同名', '`b`')
    ]));
    expect(p.ok).toBe(false);
    expect(p.problems.join()).toMatch(/中文名重复/);
  });

  it('A10 只有表头没有数据行 ⇒ ok:false（"没有功能"与"读不到"不许长得一样）', () => {
    const p = roster.parseRoster(fixtureDoc([]));
    expect(p.ok).toBe(false);
    expect(p.problems.join()).toMatch(/一行数据都没有/);
  });

  it('A11 splitStatus：`未实现（部分）` 必须被整体认出（长的在前判），旁注与取值分开', () => {
    expect(roster.splitStatus('未实现（部分）')).toEqual({ status: '未实现（部分）', statusDetail: '' });
    expect(roster.splitStatus('**未实现**')).toEqual({ status: '未实现', statusDetail: '' });
    const withNote = roster.splitStatus('已实现（**单级那一半本来就绿**：…）');
    expect(withNote.status).toBe('已实现');
    expect(withNote.statusDetail.indexOf('单级那一半') >= 0).toBe(true);
    // 闭集外的取值**原样露出**（不静默归一成"未实现"）
    expect(roster.splitStatus('做完一半').status).toBe('做完一半');
  });

  it('A12 ledgerOf：`台账 \\`Wnn\\`` 才认，没有就是 null', () => {
    expect(roster.ledgerOf('台账 `W17`。与 `CC` 的区别…')).toBe('W17');
    expect(roster.ledgerOf('2026-10-19 用户确认名字')).toBe(null);
  });
});

describe('B 承接提及：名字边界（七种"形似命令"的写法一个都不许命中）', () => {
  it('B1 `search` 不命中 `search-all` / `search_nodes`；`add` 不命中 `assoc-add`', () => {
    expect(roster.nameHit('用 `search-all` 全库检索', 'search')).toBe(false);
    expect(roster.nameHit('MCP `search_nodes` 不给 project', 'search')).toBe(false);
    expect(roster.nameHit('`assoc-add` 加一篇', 'add')).toBe(false);
    expect(roster.nameHit('`search` 必须点名单个项目', 'search')).toBe(true);
  });

  it('B2 `links` 不命中 `links[]` 字段；`draft-map` 不命中 `draft-map.html`', () => {
    expect(roster.nameHit('只沿 `links[].caption` 走', 'links')).toBe(false);
    expect(roster.nameHit('`renderer/draft-map.html` 是草稿页', 'draft-map')).toBe(false);
    expect(roster.nameHit('`links-prune` 清悬挂', 'links')).toBe(false);
  });

  it('B3 `import-dir` 不命中 `menu:import-dir`（IPC 通道名）；`projects` 不命中 `projects/` 目录', () => {
    expect(roster.nameHit('`main.js` 发 `menu:import-dir`', 'import-dir')).toBe(false);
    expect(roster.nameHit('**不落 `projects/`**、关窗即弃', 'projects')).toBe(false);
    expect(roster.nameHit('`import-dir <新项目> <目录> --vault`', 'import-dir')).toBe(true);
  });
});

describe('C 调用形态候选（差集①的输入，不许依赖 registry）', () => {
  it('C1 真调用（后面跟选项/占位）算候选', () => {
    expect(roster.invocationNames('`bind-sync <项目> --bind --dir <目录>`')).toEqual(['bind-sync']);
    expect(roster.invocationNames('`apply --ops-file ops.json`')).toEqual(['apply']);
    expect(roster.invocationNames('`timeline [<项目>] [--since <ISO>]`')).toEqual(['timeline']);
  });

  it('C2 `node cli/mm-cli.js …` / `electron .` / 单词 span / `.html` / `tag-*` / 字段名 都不是候选', () => {
    expect(roster.invocationNames('**验证** `node cli/mm-cli.js bind-sync --help` ⇒ exit 0')).toEqual([]);
    expect(roster.invocationNames('`electron . --smoke --only=55`')).toEqual([]);
    // 单词 span：`at` / `path` / `children` 这类字段名与命令名在**词面上**无法区分（能力边界，见模块头）
    expect(roster.invocationNames('条目层 `at` 在真实语料里是空集')).toEqual([]);
    expect(roster.invocationNames('`draft-map.html` + `src/draft-map.js`')).toEqual([]);
    expect(roster.invocationNames('命令表里 `tag-*` **零条**')).toEqual([]);
  });
});

describe('D 两个差集（本命令最有价值的输出）', () => {
  const NAMES = ['search', 'search-all', 'bind-sync'];

  it('D1 docOnly：名册按调用形态提到、registry 里没有 ⇒ 逐条点名并带出现它的代号', () => {
    const md = fixtureDoc([
      mkRow('AA', '甲功能', '`bind-sync <项目> --bind`'),
      mkRow('BB', '乙功能', '`ghost-cmd --x`')
    ]);
    const m = roster.buildModel({ md, names: NAMES });
    expect(m.ok).toBe(true);
    expect(m.docOnly).toEqual([{ name: 'ghost-cmd', codes: ['BB'] }]);
  });

  it('D2 unmentioned：registry 有、名册任何一行都没提 ⇒ 码点序列出（含 `search-all` 不被 `search` 蒙过去）', () => {
    const md = fixtureDoc([mkRow('AA', '甲功能', '`bind-sync <项目> --bind`')]);
    const m = roster.buildModel({ md, names: NAMES });
    expect(m.mentionedCount).toBe(1);
    expect(m.unmentioned).toEqual(['search', 'search-all']);
    expect(m.registryTotal).toBe(3);
    expect(m.mentionedCount + m.unmentioned.length).toBe(m.registryTotal);
  });

  it('D3 别名命中归一成正式名（同一件事不许两个名字）', () => {
    const md = fixtureDoc([mkRow('AA', '甲功能', '用 `tree` 看结构')]);
    const m = roster.buildModel({ md, names: ['list'], aliases: { tree: 'list' } });
    expect(m.rows[0].commands).toEqual(['list']);
    expect(m.unmentioned).toEqual([]);
  });

  it('D4 真实文档：差集① 为 0（名册里每一处「命令 + 选项/占位」都在 registry 里登记过）', () => {
    // 真值 = 现场从 registry 取，不写死清单（写死就成第二份副本）
    const m = roster.buildModel(Object.assign({ md: REAL_MD }, registryShape()));
    expect(m.ok).toBe(true);
    expect(m.docOnly).toEqual([]);
    expect(m.unmentioned.indexOf('features') >= 0).toBe(true);  // 本命令自己不是"产品功能"，名册里没有它
    expect(m.mentionedCount).toBe(m.registryTotal - m.unmentioned.length);
  });
});

describe('E 三处联合检索的判别力（`GAP-4` 的反面：`SC` / 来源链 / source-chain 三处都命中同一行）', () => {
  const buildReal = () => roster.buildModel(Object.assign({ md: REAL_MD }, registryShape()));

  it('E1 `--grep source-chain` 与 `--grep 来源链` **都命中 `SC` 那一行**（今天之前前者 0 命中）', () => {
    const m = buildReal();
    const byCmd = roster.searchRows(m.rows, 'source-chain').map((r) => r.code);
    const byName = roster.searchRows(m.rows, '来源链').map((r) => r.code);
    expect(byCmd).toEqual(['SC']);
    expect(byName).toEqual(['SC']);
    expect(roster.matchSurfaces(roster.findByCode(m.rows, 'SC'), 'source-chain')).toEqual(['commands']);
    expect(roster.matchSurfaces(roster.findByCode(m.rows, 'SC'), '来源链')).toEqual(['name']);
  });

  it('E2 代号面：大小写不敏感（`sc` 与 `SC` 命中同一行），中文名面不受影响', () => {
    const m = buildReal();
    expect(roster.searchRows(m.rows, 'sc').map((r) => r.code)).toEqual(['SC']);
    expect(roster.searchRows(m.rows, '草稿图').map((r) => r.code)).toEqual(['DM']);
  });

  it('E3 只搜三处：搜 `一句话` 列里的词**不该**命中（判据不许悄悄变宽）', () => {
    // 夹具里的「一句话」列是固定的 `一句话` 三个字，它不在代号/中文名/命令名任何一处 ⇒ 必须 0 命中
    const md = fixtureDoc([mkRow('AA', '甲功能', '`bind-sync <项目> --bind`')]);
    const m = roster.buildModel({ md, names: ['bind-sync'] });
    expect(m.rows[0].summary).toBe('一句话');
    expect(roster.matchSurfaces(m.rows[0], '一句话')).toEqual([]);
    expect(roster.searchRows(m.rows, '一句话')).toEqual([]);
    expect(roster.searchRows(m.rows, 'bind-sync').map((r) => r.code)).toEqual(['AA']);
  });

  it('E4 0 命中 ⇒ 空数组（命令层据此打出"搜过哪三处"，不静默返回空）', () => {
    const m = buildReal();
    expect(roster.searchRows(m.rows, 'zzzz-not-exist')).toEqual([]);
  });

  it('E5 findByCode：`dm` 与 `DM` 取到同一行；不存在的代号 ⇒ null', () => {
    const m = buildReal();
    expect(roster.findByCode(m.rows, 'dm').code).toBe('DM');
    expect(roster.findByCode(m.rows, 'DM').code).toBe('DM');
    expect(roster.findByCode(m.rows, 'ZZ')).toBe(null);
  });
});

describe('F 确定性（`--json` 两跑逐字节相同的地基）', () => {
  it('F1 同一份输入两跑，模型序列化后逐字节相同（不读时钟、不读目录顺序、排序码点序）', () => {
    // buildModel 每次从同一份 md 现算 ⇒ 两次结果必须一模一样（含数组顺序）——
    // 命令层"两跑 sha256 相同"的地基就在这一条上。
    const one = JSON.stringify(roster.buildModel(Object.assign({ md: REAL_MD }, registryShape())));
    const two = JSON.stringify(roster.buildModel(Object.assign({ md: REAL_MD }, registryShape())));
    expect(one).toBe(two);
  });

  it('F2 三处检索面的清单只有一处定义（报文与 `--json` 的 searchedIn 读同一份）', () => {
    expect(roster.SEARCH_SURFACES.map((s) => s.key)).toEqual(['code', 'name', 'commands']);
  });
});
