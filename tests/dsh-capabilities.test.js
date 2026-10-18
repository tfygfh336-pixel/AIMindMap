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
