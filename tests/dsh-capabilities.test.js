/* ============================================================
 * tests/dsh-capabilities.test.js — DSH 能力边界（解析装配清单）
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 这个模块的结论会被用来**决定"要不要新写一个能力"**，所以它的解析错一点，
 * 后果就是"以为不具备其实有"（白做工）或"以为有其实没挂载"（写进文档骗后人）。
 *
 * ⚠️ **本文件曾经"守着一个假前提"（2026-10-19 修）** —— 记在这里，免得再犯同型：
 *   旧版最后那组断言自称验证「6 个装配文件里**没有任何一处嵌套** `- id:`」这个前提，
 *   实际只做了两件**不相干**的事：① 断言"id 行都带 `-`"（**与缩进无关**）；
 *   ② 读 9 个 host `cordis.patch.yml` + **0 个 preset 文件**（发现的路径在本运行包里不存在）。
 *   而实测装配面**是嵌套的**（现算 375 行 `- id:` 里只有 40 行在文件顶层）⇒ **前提已假、门禁仍绿**。
 *
 * ⇒ 现在断言的是**按行解析真正依赖的两条前提**，且两条都能**真红**：
 *   ① **键的归属**：每个 `name:` / `disabled:` 键行都落在最近上方 `- id:` 行的 **+2 缩进**
 *      （不是"任意缩进都算这一行的" —— 那样会把 `config:` 里的 `name:` 当成包名）；
 *   ② **容器面**：每个 `- id:` 行的容器必须是模块声明的三类之一
 *      （`root` / `- insert:` 列表 / 接条目列表的插件 `config.plugins[]`）——
 *      落不到这三类 ⇒ 那些行**不在能力面内**，判定不完整 ⇒ **判红**。
 *      判别力：往一个**非条目列表**的 `config.plugins[]` 里加一行嵌套 `- id:` ⇒ 必红
 *      （证明见 `.review/20261019-capabilities前提复核/README.md`；同一行加进 **preset 的**
 *      `plugins[]` 则保持绿 —— 说明这条门禁判的是"在哪"，不是"有没有嵌套"）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const caps = require('../src/dsh-capabilities.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DSH_NM = path.join(ROOT, 'vendor', 'dsh', 'app', 'node_modules', '@deepseek-ai');

describe('parseMountRows：按行解析，但**按缩进算归属**', () => {
  const src = [
    '- insert:',
    '    - id: timer',
    "      name: '@deepseek-ai/cordis-plugin-timer'",
    '',
    '    - id: hmr',
    "      name: '@deepseek-ai/cordis-plugin-hmr'",
    '      disabled: true',
    '      config:',
    "        root: ['.']",
    '',
    '    - id: system-prompt',
    '      config:',
    '        personaSuffix: hi'
  ].join('\n');

  it('取出 id / name / disabled；disabled 在 config 之前后出现都能抓到', () => {
    const rows = caps.parseMountRows(src);
    expect(rows.map((r) => r.id)).toEqual(['timer', 'hmr', 'system-prompt']);
    expect(rows[0].name).toBe('@deepseek-ai/cordis-plugin-timer');
    expect(rows[0].disabled).toBe(false);
    expect(rows[1].disabled).toBe(true);
    expect(rows[1].disabledState).toBe('literal-true');
  });

  it('只有 id 没有 name ⇒ name 为 null（patch 语义：按 id 覆盖上游行，不新引入包）', () => {
    const rows = caps.parseMountRows(src);
    expect(rows[2].name).toBe(null);
  });

  it('**只认该行自己那一级**：config 里更深的 name / disabled 不算这一行的（旧实现会张冠李戴）', () => {
    const s = [
      '- id: parent',
      '  config:',
      '    name: not-a-package',
      '    disabled: true',
      '    note: disabled: true 后面还有字'
    ].join('\n');
    const rows = caps.parseMountRows(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].name, 'config 里的 name 不是包名').toBe(null);
    expect(rows[0].disabled, 'config 里的 disabled 不是这一行的').toBe(false);
    expect(rows[0].disabledState).toBe('absent');
  });

  it('`disabled` 三态：字面 true / 字面 false / 表达式 / 未声明（表达式**不求值、不猜**）', () => {
    const s = [
      '- id: a',
      '  disabled: true',
      '- id: b',
      '  disabled: false',
      "- id: c",
      "  disabled: !!js process.platform === 'win32'",
      '- id: d'
    ].join('\n');
    const rows = caps.parseMountRows(s);
    expect(rows.map((r) => r.disabledState)).toEqual(['literal-true', 'literal-false', 'expr', 'absent']);
    expect(rows.map((r) => r.disabled)).toEqual([true, false, null, false]);
    expect(rows[2].disabledRaw, '表达式**原文逐字保留**').toBe("!!js process.platform === 'win32'");
  });
});

describe('容器分类：`- id:` 行在哪 —— 决定它进不进能力面', () => {
  it('顶层 = root；`- insert:` 子项 = insert（depth 仍是 0：insert 不是 entry）', () => {
    const s = ['- id: over', '  disabled: true', '- insert:', '    - id: ins', "      name: '@deepseek-ai/dsh-x'"].join('\n');
    const rows = caps.parseMountRows(s);
    expect(rows.map((r) => r.container)).toEqual(['root', 'insert']);
    expect(rows.map((r) => r.depth)).toEqual([0, 0]);
  });

  it('接条目列表的插件的 config.plugins[] ⇒ config-list（`cordis:group` / agent preset）', () => {
    const s = [
      '- insert:',
      '    - id: g',
      "      name: 'cordis:group'",
      '      config:',
      '        plugins:',
      '          - id: child',
      "            name: '@deepseek-ai/dsh-y'"
    ].join('\n');
    const rows = caps.parseMountRows(s);
    expect(rows.map((r) => r.container)).toEqual(['insert', 'config-list']);
    expect(rows[1].depth, '嵌套子项有 1 个祖先 entry').toBe(1);
    expect(rows[1].inFace).toBe(true);
  });

  it('**普通插件的 config 列表是数据不是条目** ⇒ undeclared（不进能力面，报告里点名）', () => {
    const s = [
      '- id: plain',
      "  name: '@deepseek-ai/dsh-plain'",
      '  config:',
      '    plugins:',
      '      - id: looks-like-entry',
      "        name: '@deepseek-ai/not-really'"
    ].join('\n');
    const rows = caps.parseMountRows(s);
    expect(rows[1].container).toBe('undeclared');
    expect(rows[1].inFace).toBe(false);
  });
});

describe('shortName：两个来源的写法不同，不归一化就全错', () => {
  it('装配里是全名、磁盘目录是短名；子路径取第一段', () => {
    expect(caps.shortName('@deepseek-ai/dsh-tool-goal')).toBe('dsh-tool-goal');
    expect(caps.shortName('dsh-tool-goal')).toBe('dsh-tool-goal');
    expect(caps.shortName('@deepseek-ai/dsh-headless/startup')).toBe('dsh-headless');
  });
});

describe('buildModel：三轴事实（磁盘 × 装配 × disabled）', () => {
  const layers = [
    { layer: 'base', kind: 'host', text: "- id: a\n  name: '@deepseek-ai/dsh-a'\n- id: b\n  name: '@deepseek-ai/dsh-b'\n  disabled: true\n- id: a\n  config:\n    x: 1\n" },
    { layer: 'preset:std', kind: 'preset', text: "- id: a\n  name: '@deepseek-ai/dsh-a'\n- id: c\n  name: 'cordis:group'\n" }
  ];
  const model = caps.buildModel({ layers, diskPackages: ['dsh-a', 'dsh-b', 'dsh-z'] });

  it('unmounted = 磁盘上有、但没有任何层挂载', () => {
    expect(model.unmounted).toEqual(['dsh-z']);
  });

  it('**disabled: true 仍然算"已挂载"** —— 只是该层不用它（别处可能重挂）', () => {
    expect(model.mounted).toContain('dsh-b');
    expect(model.packageLayers.get('dsh-b')).toEqual([{ layer: 'base', disabled: true }]);
  });

  it('同一包在多层出现时逐层记录；同一层内出现两次不重复记', () => {
    expect(model.packageLayers.get('dsh-a').map((x) => x.layer)).toEqual(['base', 'preset:std']);
  });

  it('合成分组（带冒号）不算包，也不进 missingOnDisk', () => {
    expect(model.groups).toEqual(['cordis:group']);
    expect(model.mounted).not.toContain('cordis:group');
    expect(model.missingOnDisk).toEqual([]);
  });

  it('装配点名了磁盘上没有的包 ⇒ 进 missingOnDisk（值得警惕，不是正常状态）', () => {
    const m2 = caps.buildModel({ layers: [{ layer: 'x', kind: 'host', text: "- id: q\n  name: 'dsh-nonexistent'\n" }], diskPackages: ['dsh-a'] });
    expect(m2.missingOnDisk).toEqual(['dsh-nonexistent']);
  });

  it('层统计：按 id 覆盖数 = 行数 − 有 name 的行数', () => {
    expect(model.layers[0]).toMatchObject({ layer: 'base', rows: 3, withName: 2, overridesById: 1, disabled: 1 });
  });

  it('`expr` 行：**进挂载集、但启用状态未知**（`disabled === null`），且被单独点名', () => {
    const m3 = caps.buildModel({
      layers: [{ layer: 'h', kind: 'host', text: "- id: e\n  name: '@deepseek-ai/dsh-e'\n  disabled: !!js process.platform === 'win32'\n" }],
      diskPackages: ['dsh-e']
    });
    expect(m3.mounted).toContain('dsh-e');                                  // 挂载是事实
    expect(m3.packageLayers.get('dsh-e')).toEqual([{ layer: 'h', disabled: null }]); // 启不启用是**未知**
    expect(m3.exprRows).toHaveLength(1);
    expect(m3.layers[0]).toMatchObject({ disabled: 0, disabledExpr: 1 });   // 不许算进 disabled，也不许算进 enabled
    expect(caps.renderReport(m3, {})).toMatch(/未知[\s\S]*· h：e（行 1）/);
  });

  it('同层多行同一包：**启用 > 未知 > 禁用**（有一行启用 ⇒ 这个包在该层可用）', () => {
    expect(caps.mergeDisabled(true, false)).toBe(false);
    expect(caps.mergeDisabled(true, null)).toBe(null);
    expect(caps.mergeDisabled(true, true)).toBe(true);
  });

  it('**容器落不到声明三类的行不进能力面，且被逐行点名**（不许静默当挂载）', () => {
    const m4 = caps.buildModel({
      layers: [{
        layer: 'h', kind: 'host',
        text: "- id: plain\n  name: '@deepseek-ai/dsh-plain'\n  config:\n    plugins:\n      - id: data-not-entry\n        name: '@deepseek-ai/dsh-ghost'\n"
      }],
      diskPackages: ['dsh-plain']
    });
    expect(m4.mounted).toEqual(['dsh-plain']);          // ghost 没进挂载集
    expect(m4.containers.undeclared).toBe(1);
    expect(m4.undeclared).toEqual([{ layer: 'h', id: 'data-not-entry', line: 5, container: 'undeclared' }]);
    expect(m4.layers[0].undeclared).toBe(1);
    const rep = caps.renderReport(m4, {});
    expect(rep).toMatch(/不在能力面内/);
    expect(rep).toMatch(/data-not-entry/);
  });
});

/* ============================================================
 * 纯 id 覆盖行（`- id: X` + `disabled: …`，**不带 `name`**）必须落到包上
 * ------------------------------------------------------------
 * ⚠️ **这里曾是一个静默缺口（2026-10-19 修）**：原 `buildModel` 只按「带 `name:` 的行」归属包，
 *   于是这类行的 `disabled` **整条记录都不进 `packages[].layers`**（不是读成 `false`，是消失）。
 *   实测 40 行（其中 33 行自带 `disabled`），全在 host 层、`dsh-web-app` 一层就 24 行。
 *   ⇒ `dsh-compaction-basic` / `dsh-agent-instructions` 在 `dsh-web-app` 层 `disabled: true`
 *   在输出里**完全看不到** —— 读报告的人会以为"该能力在 host 层是启用的"。
 * ============================================================ */
describe('纯 id 覆盖行的归属：沿装配序列找该 id 的声明行', () => {
  it('`assemblySequenceOf`：host 层 = `dsh-base` → 本层；preset 层 = `dsh-base` → 载体 → 本层', () => {
    expect(caps.assemblySequenceOf({ layer: 'dsh-base', kind: 'host' })).toEqual(['dsh-base']);
    expect(caps.assemblySequenceOf({ layer: 'dsh-web-app', kind: 'host' })).toEqual(['dsh-base', 'dsh-web-app']);
    expect(caps.assemblySequenceOf({ layer: 'preset:dsh-web-app/standard', kind: 'preset' }))
      .toEqual(['dsh-base', 'dsh-web-app', 'preset:dsh-web-app/standard']);
    // 层名不带载体（旧式 / 合成层）也不能少算自己
    expect(caps.assemblySequenceOf({ layer: 'preset:std', kind: 'preset' })).toEqual(['dsh-base', 'preset:std']);
  });

  it('`presetCarrierOf`：载体包只有一处推导（release.js 的 findRemounts 也用它）', () => {
    expect(caps.presetCarrierOf('preset:dsh-web-app/standard')).toBe('dsh-web-app');
    expect(caps.presetCarrierOf('dsh-web-app')).toBe(null);
  });

  it('**同层声明的纯 id 行落到包**（`disabled: true` 不再消失）', () => {
    const m = caps.buildModel({
      layers: [{ layer: 'dsh-web-app', kind: 'host',
        text: "- id: x\n  name: '@deepseek-ai/dsh-x'\n- id: y\n  name: '@deepseek-ai/dsh-y'\n- id: x\n  disabled: true\n" }],
      diskPackages: ['dsh-x', 'dsh-y']
    });
    // x 在这一层有"启用"的声明行 + 纯 id 的 `disabled: true` ⇒ 三态合并 启用 > 禁用
    expect(m.packageLayers.get('dsh-x')).toEqual([{ layer: 'dsh-web-app', disabled: false }]);
    expect(m.layers[0]).toMatchObject({ overridesById: 1, resolvedById: 1 });
    expect(m.idUnresolved).toEqual([]);
  });

  it('**跨层（`dsh-base` 声明、`dsh-web-app` 只给 id + disabled）**：落到声明那个包上', () => {
    const m = caps.buildModel({
      layers: [
        { layer: 'dsh-base', kind: 'host', text: "- id: compaction-basic\n  name: '@deepseek-ai/dsh-compaction-basic'\n" },
        { layer: 'dsh-web-app', kind: 'host', text: "- id: compaction-basic\n  disabled: true\n" }
      ],
      diskPackages: ['dsh-compaction-basic']
    });
    expect(m.packageLayers.get('dsh-compaction-basic')).toEqual([
      { layer: 'dsh-base', disabled: false },
      { layer: 'dsh-web-app', disabled: true }
    ]);
    expect(m.idResolvedRows).toBe(1);
  });

  it('**解析不到声明 ⇒ 不猜**：`pkg` 不进挂载集，记进 `idUnresolved` 并在报告里点名', () => {
    const m = caps.buildModel({
      layers: [{ layer: 'dsh-web-app', kind: 'host', text: "- id: ghost\n  disabled: true\n" }],
      diskPackages: ['dsh-x']
    });
    expect(m.mounted).not.toContain('ghost');
    expect(m.idUnresolved).toEqual([{
      layer: 'dsh-web-app', id: 'ghost', line: 1, reason: 'no-declaration',
      disabledState: 'literal-true', candidates: []
    }]);
    const rep = caps.renderReport(m, {});
    expect(rep).toMatch(/解析不到唯一的包/);
    expect(rep).toMatch(/ghost/);
  });

  it('**多候选 ⇒ 不猜**：列出全部候选（照 `expr` 三态口径），不挑一个', () => {
    const m = caps.buildModel({
      layers: [{ layer: 'dsh-web-app', kind: 'host', text:
        "- id: x\n  name: '@deepseek-ai/dsh-a'\n- id: x\n  name: '@deepseek-ai/dsh-b'\n- id: x\n  disabled: true\n" }],
      diskPackages: ['dsh-a', 'dsh-b']
    });
    expect(m.idUnresolved).toHaveLength(1);
    expect(m.idUnresolved[0].reason).toBe('ambiguous');
    expect(m.idUnresolved[0].candidates.map((c) => c.pkg)).toEqual(['dsh-a', 'dsh-b']);
    expect(caps.renderReport(m, {})).toMatch(/多候选：dsh-a/);
  });

  it('**另一套并列 bundle 里同名 id 的声明与本层无关**（不许跨 bundle 串）', () => {
    const m = caps.buildModel({
      layers: [
        { layer: 'dsh-headless', kind: 'host', text: "- id: x\n  name: '@deepseek-ai/dsh-x'\n" },
        { layer: 'dsh-web-app', kind: 'host', text: "- id: x\n  disabled: true\n" }
      ],
      diskPackages: ['dsh-x']
    });
    // `dsh-headless` 不在 `dsh-web-app` 的序列里 ⇒ 该行**解析不到包**，而不是借用另一套的
    expect(m.idUnresolved.map((u) => u.layer)).toEqual(['dsh-web-app']);
    expect(m.packageLayers.get('dsh-x')).toEqual([{ layer: 'dsh-headless', disabled: false }]);
  });

  it('**纯 id 行没写 `disabled` ⇒ 不贡献状态**（否则会把同层另一行的 `disabled: true` 抹成启用）', () => {
    const m = caps.buildModel({
      layers: [
        { layer: 'dsh-base', kind: 'host', text: "- id: p\n  name: '@deepseek-ai/dsh-p'\n" },
        { layer: 'dsh-web-app', kind: 'host', text:
          "- id: q\n  name: '@deepseek-ai/dsh-p'\n  disabled: true\n"
          + "- id: p\n  config:\n    a: 1\n" }],
      diskPackages: ['dsh-p']
    });
    // 注意：带 `name` 的行是**一次真实挂载**，未写 `disabled` = 默认启用（那是另一条口径，别混）；
    // 这里故意让"纯 id 行"只改 config —— 它不该把 q 行的禁用抹掉。
    expect(m.packageLayers.get('dsh-p'), 'p 行只改 config、没声明启用，不该把 q 行的禁用抹掉').toEqual([
      { layer: 'dsh-base', disabled: false },
      { layer: 'dsh-web-app', disabled: true }
    ]);
  });
});


/* ============================================================
 * 真实文件：验证**按行解析真正依赖的两条前提**（不是"装配面扁平"那条假前提）
 * ============================================================ */
describe('真实 vendor 装配文件（前提验证）', () => {
  const hasVendor = fs.existsSync(DSH_NM);

  /** host 装配文件 + **preset 装配文件**（旧版后者一个都没读 —— 这是同一个缺陷的另一半） */
  function discoverAssemblyFiles() {
    const out = [];
    for (const name of fs.readdirSync(DSH_NM).sort()) {
      const host = path.join(DSH_NM, name, 'cordis.patch.yml');
      if (fs.existsSync(host)) out.push({ pkg: name, kind: 'host', file: host });
      const presetsDir = path.join(DSH_NM, name, 'presets');
      if (!fs.existsSync(presetsDir)) continue;
      for (const f of fs.readdirSync(presetsDir).sort()) {
        if (!/\.patch\.yml$/.test(f)) continue;
        out.push({ pkg: name, kind: 'preset', file: path.join(presetsDir, f) });
      }
    }
    return out;
  }
  const FILES = hasVendor ? discoverAssemblyFiles() : [];
  const read = (f) => fs.readFileSync(f, 'utf8');

  it('vendor/dsh 存在（本机应当有；缺失时其余断言会跳过而不是假通过）', () => {
    // 不强断言存在：vendor/ 被 git 忽略，别的机器上可能没有。
    // 这里的意义是"把这件事显式说出来"，而不是静默跳过。
    expect(typeof hasVendor).toBe('boolean');
  });

  it.runIf(hasVendor)('**装配文件集必须含 preset 文件** —— 旧版这里读的是 0 个（路径在本运行包里不存在）', () => {
    const presets = FILES.filter((f) => f.kind === 'preset');
    expect(FILES.filter((f) => f.kind === 'host').length).toBeGreaterThan(3);
    expect(presets.length, '应真的读到 preset 装配文件（每个文件都必须被解析到行）').toBeGreaterThan(0);
    for (const f of presets) expect(caps.parseMountRows(read(f.file)).length).toBeGreaterThan(0);
  });

  it.runIf(hasVendor)('前提 ①：每个 `name:` / `disabled:` 键行都落在最近上方 `- id:` 行的 +2 缩进', () => {
    for (const f of FILES) {
      const lines = read(f.file).split('\n');
      const rows = caps.parseMountRows(read(f.file));
      const orphan = [];
      for (let i = 0; i < lines.length; i++) {
        const m = /^(\s*)(name|disabled):\s*(.*)$/.exec(lines[i]);
        if (!m) continue;
        // 归属 = 最近的上方 `- id:` 行（原始行扫描，不看 parser 的判断）
        let owner = null;
        for (let k = rows.length - 1; k >= 0; k--) if (rows[k].line < i + 1) { owner = rows[k]; break; }
        const own = owner ? owner.indent + 2 : null;
        if (own === null || m[1].length !== own) {
          orphan.push('行 ' + (i + 1) + ' 的 ' + m[2] + ' 缩进 ' + m[1].length + '，应为 ' + own
            + '（归属 ' + (owner ? owner.id : '无') + '）');
        }
      }
      expect(orphan, path.basename(f.file) + ' 出现"键不在自己那一级"的行 ⇒ 按行解析会漏读 / 张冠李戴').toEqual([]);
    }
  });

  it.runIf(hasVendor)('前提 ②：每行容器都在声明的三类里（落不到 ⇒ 判红，能力面判定不完整）', () => {
    const offenders = [];
    for (const f of FILES) {
      for (const r of caps.parseMountRows(read(f.file))) {
        if (caps.CONTAINERS.indexOf(r.container) < 0) {
          offenders.push(path.basename(f.file) + ':' + r.line + ' ' + r.id + '（容器 ' + r.container + '）');
        }
      }
    }
    expect(offenders, '这些行的容器没被声明 ⇒ 它们不在能力面内；'
      + '要么扩 `CONTAINERS` / `ENTRY_LIST_HOLDERS`（`src/dsh-capabilities.js`），要么查清它们是不是数据').toEqual([]);
  });

  it.runIf(hasVendor)('行集完整：解析行数 == 原始 `- id:` 行数，且 id 文本逐行一致（不漏行、不多行）', () => {
    for (const f of FILES) {
      const text = read(f.file);
      const raw = text.split('\n')
        .map((l, i) => ({ l, i }))
        .filter((x) => /^\s*- id:/.test(x.l))
        .map((x) => (/^\s*- id:\s*(\S.*?)\s*$/.exec(x.l) || [null, null])[1].replace(/^['"]|['"]$/g, ''));
      const parsed = caps.parseMountRows(text).map((r) => r.id);
      expect(parsed, path.basename(f.file) + ' 的行集与原始 `- id:` 行不一致'
        + '（flow 写法 / 行尾注释 / 紧凑写全会在这里暴露）').toEqual(raw);
    }
  });

  it.runIf(hasVendor)('装配面**是嵌套的**，且报告把现算的观察面印出来（别自称扁平）', () => {
    const layers = FILES.map((f) => ({ layer: f.pkg + '/' + path.basename(f.file), kind: f.kind, text: read(f.file) }));
    const m = caps.buildModel({ layers, diskPackages: [] });
    const total = m.containers.root + m.containers.insert + m.containers['config-list'] + m.containers.undeclared;
    expect(total, '观察面总数应等于全部行').toBe(layers.reduce((a, l) => a + caps.parseMountRows(l.text).length, 0));
    expect(m.containers.root + m.containers.insert + m.containers['config-list'],
      '非 root 的行必须存在 —— 若这条红了：装配面可能被上游压平了，先重读模块头「声明能力面」那节再改断言').toBeGreaterThan(m.containers.root);
    const rep = caps.renderReport(m, {});
    expect(rep).toMatch(new RegExp('观察面（现算：' + total + ' 行'));
    expect(rep).toMatch(/装配面\*\*是嵌套的\*\*/);
    expect(rep).toMatch(/落不到这三类的行：\*\*0\*\*/);
    expect(m.undeclared, '真实装配面上不该有"未声明容器"的行').toEqual([]);
  });

  it.runIf(hasVendor)('真实文件里的 `disabled` **不是布尔**：表达式行的 `disabled` 必须是 `null`', () => {
    let expr = 0;
    for (const f of FILES) {
      for (const r of caps.parseMountRows(read(f.file))) {
        if (r.disabledState !== 'expr') continue;
        expr += 1;
        expect(r.disabled, '表达式行不许当启用（旧实现把它读成 enabled）').toBe(null);
        expect(r.disabledRaw, '表达式原文必须保留').toMatch(/^!!js\s/);
      }
    }
    expect(expr, '本运行包里确实有表达式行；若为 0 说明口径变了，先复核').toBeGreaterThan(0);
  });

  it.runIf(hasVendor)('报告里 expr 行**逐个点名**（不许静默当 enabled）', () => {
    const layers = FILES.map((f) => ({ layer: f.pkg, kind: f.kind, text: read(f.file) }));
    const m = caps.buildModel({ layers, diskPackages: [] });
    expect(m.exprRows.length).toBeGreaterThan(0);
    const rep = caps.renderReport(m, {});
    for (const e of m.exprRows) expect(rep).toContain(e.id);
  });

  it.runIf(hasVendor)('**本机确实存在并列的多套 host bundle**（"看不到≠不具备"的实证）', () => {
    const hosts = fs.readdirSync(DSH_NM).filter((n) => fs.existsSync(path.join(DSH_NM, n, 'cordis.patch.yml')));
    expect(hosts.length).toBeGreaterThan(2); // 实测多套：base / web-app / headless / acp-app / sdk-app / sdk-minimal …
    expect(hosts).toContain('dsh-headless'); // 无 GUI 批量执行走的是**另一套** bundle
  });

  it.runIf(hasVendor)('磁盘包数与挂载情况能算出有意义的三轴结果', () => {
    const layers = [];
    for (const name of fs.readdirSync(DSH_NM)) {
      const p = path.join(DSH_NM, name, 'cordis.patch.yml');
      if (fs.existsSync(p)) layers.push({ layer: name, kind: 'host', text: fs.readFileSync(p, 'utf8') });
    }
    const disk = fs.readdirSync(DSH_NM).filter((n) => fs.statSync(path.join(DSH_NM, n)).isDirectory());
    const m = caps.buildModel({ layers, diskPackages: disk });
    expect(m.diskCount).toBeGreaterThan(100);
    expect(m.mounted.length).toBeGreaterThan(50);
    expect(m.unmounted.length).toBeGreaterThan(0);   // 确实有"在磁盘但没挂载"的包
    expect(m.missingOnDisk.length).toBeLessThan(5);  // 不该有大批对不上的名字（那说明归一化坏了）
    expect(m.mounted.length - m.missingOnDisk.length + m.unmounted.length).toBe(m.diskCount);
  });
});

/* ============================================================
 * 真实文件：`packages[].layers` 的 `disabled` 与**裸读 yml** 逐条一致
 * ------------------------------------------------------------
 * 判据不是"模块算得跟自己一样"（那是自证），而是拿一个**另一个实现**来对：
 * 下面 `bareScanRows` 只做"最近上方 `- id:` 行 +2 缩进"的**原始行扫描**
 * （不看 `parseMountRows` 的容器栈判断），再按
 * 「带 name ⇒ 归 shortName(name)」「不带 name ⇒ 沿 `base → 载体 → 本层` 找该 id 的 name 声明」
 * 独立算出每个 (包, 层) 的三态并合并，**与 `buildModel` 的 `packageLayers` 逐条比对**。
 *
 * 判别力（两次注入都实测变红，见 `.review/20261019-caps-id-override/README.md`）：
 *   · 把纯 id 行的 `disabled: true` 丢掉（当 `absent` 处理）⇒ 红；
 *   · 把归属退回"只认带 name 的行"（修复前的行为）⇒ 红。
 * ============================================================ */
describe('真实 vendor 装配文件：per-layer disabled 与裸读 yml 逐条一致', () => {
  const hasVendor = fs.existsSync(DSH_NM);

  /** **裸读**：原始行扫描，只认"最近上方 `- id:` 行的 +2 缩进"这一条，不看容器栈 */
  function bareScanRows(text) {
    const lines = String(text).split('\n');
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)- id:\s*(\S.*?)\s*$/.exec(lines[i]);
      if (!m) continue;
      const indent = m[1].length;
      const row = { id: m[2].replace(/^['"]|['"]$/g, ''), line: i + 1, name: null, disabledRaw: null };
      for (let k = i + 1; k < lines.length; k++) {
        const l = lines[k];
        if (l.trim() === '' || /^\s*#/.test(l)) continue;
        if (/^\s*/.exec(l)[0].length <= indent) break;             // 这一条目结束
        const km = /^(\s*)(name|disabled):\s*(.*?)\s*$/.exec(l);
        if (!km || km[1].length !== indent + 2) continue;           // 更深的不属于这一行
        if (km[2] === 'name' && row.name === null) row.name = km[3].replace(/^['"]|['"]$/g, '');
        if (km[2] === 'disabled' && row.disabledRaw === null) row.disabledRaw = km[3];
      }
      rows.push(row);
    }
    return rows;
  }

  /** 三态（与模块同一口径，但独立算） */
  function stateOfRaw(raw) {
    if (raw === null) return 'absent';
    if (String(raw).trim() === 'true') return 'literal-true';
    if (String(raw).trim() === 'false') return 'literal-false';
    return 'expr';
  }

  const LAYERS = [];
  if (hasVendor) {
    for (const name of fs.readdirSync(DSH_NM).sort()) {
      const p = path.join(DSH_NM, name, 'cordis.patch.yml');
      if (fs.existsSync(p)) LAYERS.push({ layer: name, kind: 'host', carrier: null, file: p });
      const d = path.join(DSH_NM, name, 'presets');
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d).filter((x) => /\.patch\.yml$/.test(x)).sort()) {
        LAYERS.push({ layer: 'preset:' + name + '/' + f.replace(/\.patch\.yml$/, ''), kind: 'preset', carrier: name, file: path.join(d, f) });
      }
    }
    for (const L of LAYERS) L.text = fs.readFileSync(L.file, 'utf8');
  }

  /** 独立算出「每个 (包, 层) 的 disabled」——**只用裸读的行 + 装配序列** */
  function truthPairs() {
    const decl = new Map();     // id → [{pkg, layer}]
    for (const L of LAYERS) {
      for (const r of bareScanRows(L.text)) {
        if (!r.name || r.name.indexOf(':') >= 0) continue;
        if (!decl.has(r.id)) decl.set(r.id, []);
        decl.get(r.id).push({ pkg: caps.shortName(r.name), layer: L.layer });
      }
    }
    // ⚠️ 这里的序列是**判据侧的独立实现**（故意不调 `caps.assemblySequenceOf`）——
    //    「另一侧读数」要是也调被测函数，这条判据就退化成自证。
    const seqOf = (L) => {
      const carrier = L.kind === 'preset' ? L.carrier : L.layer;
      const seq = ['dsh-base'];
      if (carrier && carrier !== 'dsh-base') seq.push(carrier);
      if (seq.indexOf(L.layer) < 0) seq.push(L.layer);
      return seq;
    };
    const acc = new Map();      // layer\0pkg → disabled
    const merge = (a, b) => (a === false || b === false ? false : (a === null || b === null ? null : true));
    const unresolved = [];
    for (const L of LAYERS) {
      const seq = seqOf(L);
      for (const r of bareScanRows(L.text)) {
        const st = stateOfRaw(r.disabledRaw);
        let pkg = null;
        if (r.name && r.name.indexOf(':') >= 0) continue;                 // 合成分组，不是包
        if (r.name) pkg = caps.shortName(r.name);
        else {
          const c = (decl.get(r.id) || []).filter((x) => seq.indexOf(x.layer) >= 0);
          const uniq = [...new Set(c.map((x) => x.pkg))];
          if (uniq.length !== 1) { unresolved.push({ layer: L.layer, id: r.id, uniq }); continue; }
          pkg = uniq[0];
        }
        const key = L.layer + '\u0000' + pkg;
        // 口径（与模块声明一致，这里独立实现一遍）：
        //   带 `name` 的行 = 一次真实挂载 ⇒ 未写 `disabled` 就是**默认启用**（false），参与合并；
        //   不带 `name` 的纯 id 行 = 不是挂载 ⇒ 未写 `disabled` **不贡献状态**（写了才参与合并）。
        if (st === 'absent' && !r.name) {
          if (!acc.has(key)) acc.set(key, false);
          continue;
        }
        const val = st === 'literal-true' ? true : (st === 'expr' ? null : false);
        acc.set(key, acc.has(key) ? merge(acc.get(key), val) : val);
      }
    }
    return { acc, unresolved };
  }

  it.runIf(hasVendor)('**裸读口径下，纯 id 覆盖行全部解析到唯一的包**（推导唯一性，现算）', () => {
    const { unresolved } = truthPairs();
    expect(unresolved, '真实装配面上一旦出现"同 id 多包声明"或"无声明"，本判据就不再唯一 —— '
      + '那时 `packageOfRow` 必须报 null 并点名，别改成猜一个候选').toEqual([]);
  });

  it.runIf(hasVendor)('`buildModel` 的 `packageLayers` == 裸读 yml 独立算出的 (包, 层) disabled —— **逐条**', () => {
    const { acc } = truthPairs();
    const m = caps.buildModel({
      layers: LAYERS.map((L) => ({ layer: L.layer, kind: L.kind, text: L.text })),
      diskPackages: []
    });
    const got = [];
    for (const [pkg, list] of m.packageLayers) for (const x of list) got.push({ pkg, layer: x.layer, disabled: x.disabled });
    const want = [...acc.entries()].map(([k, v]) => {
      const [layer, pkg] = k.split('\u0000');
      return { pkg, layer, disabled: v };
    });
    const norm = (a) => a.slice().sort((x, y) => (x.pkg + '\u0000' + x.layer < y.pkg + '\u0000' + y.layer ? -1 : 1));
    expect(norm(got), '每一条 (包, 层) 的 disabled 都必须与裸读 yml 算出的相同')
      .toEqual(norm(want));
    expect(m.idUnresolved, '真实装配面上不该有解析不到包的纯 id 行').toEqual([]);
    expect(m.idOverrideRows, '纯 id 覆盖行必须真的存在（为 0 说明口径变了，先复核再改断言）').toBeGreaterThan(0);
    expect(m.idResolvedRows).toBe(m.idOverrideRows);
  });

  it.runIf(hasVendor)('**叙事落点**：`dsh-compaction-basic` / `dsh-agent-instructions` 在 `dsh-web-app` 层 = `disabled: true`', () => {
    const m = caps.buildModel({
      layers: LAYERS.map((L) => ({ layer: L.layer, kind: L.kind, text: L.text })),
      diskPackages: []
    });
    for (const pkg of ['dsh-compaction-basic', 'dsh-agent-instructions']) {
      const hit = (m.packageLayers.get(pkg) || []).filter((x) => x.layer === 'dsh-web-app')[0];
      expect(hit, pkg + ' 必须在 dsh-web-app 层有记录 —— 缺了它就是"纯 id 覆盖行的 disabled 又消失了"')
        .toBeTruthy();
      expect(hit.disabled, pkg + ' 在 dsh-web-app 层是 `disabled: true`（裸读 yml 可复核）').toBe(true);
    }
    // 再独立确认一次原文里真有这两行（不靠模块自己的读数自证）
    const web = fs.readFileSync(path.join(DSH_NM, 'dsh-web-app', 'cordis.patch.yml'), 'utf8').split('\n');
    for (const id of ['compaction-basic', 'agent-instructions']) {
      const i = web.findIndex((l) => new RegExp('^- id:\\s*' + id + '\\s*$').test(l));
      expect(i, '原文里应有 `- id: ' + id + '`（无 name 的顶层行）').toBeGreaterThanOrEqual(0);
      expect(web[i + 1].trim(), '紧随其后必须就是 `disabled: true`').toBe('disabled: true');
    }
  });
});
