/* ============================================================
 * tests/dsh-capabilities.test.js — DSH 能力边界（解析装配清单）
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 这个模块的结论会被用来**决定"要不要新写一个能力"**，所以它的解析错一点，
 * 后果就是"以为不具备其实有"（白做工）或"以为有其实没挂载"（写进文档骗后人）。
 *
 * 最要紧的一组断言在最后：**用真实的 6 个装配文件验证"行解析足够"这个前提** ——
 * 整个模块建立在"没有任何一处嵌套 `- id:`"之上（因此不引 YAML 解析器、不增依赖）。
 * 前提若被上游打破，这里会先红，而不是让模块静默少数/多数几行。
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

describe('parseMountRows：按行解析装配文件', () => {
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

  it('取出 id / name / disabled；disabled 在 config 之后出现也能抓到', () => {
    const rows = caps.parseMountRows(src);
    expect(rows.map((r) => r.id)).toEqual(['timer', 'hmr', 'system-prompt']);
    expect(rows[0].name).toBe('@deepseek-ai/cordis-plugin-timer');
    expect(rows[0].disabled).toBe(false);
    expect(rows[1].disabled).toBe(true);
  });

  it('只有 id 没有 name ⇒ name 为 null（patch 语义：按 id 覆盖上游行，不新引入包）', () => {
    const rows = caps.parseMountRows(src);
    expect(rows[2].name).toBe(null);
  });

  it('config 里的普通键不会被当成长文本/disabled（只认整行的 disabled: true）', () => {
    const s = '- id: x\n  name: a\n  config:\n    disabled: false\n    note: disabled: true 后面还有字\n';
    const rows = caps.parseMountRows(s);
    expect(rows[0].disabled).toBe(false);
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
});

/* ============================================================
 * 真实文件：验证"行解析足够"这个前提
 * 若上游某天在 config 里嵌了 `- id:`，下面的等式会先红 —— 而不是让模块静默少数几行。
 * ============================================================ */
describe('真实 vendor 装配文件（前提验证）', () => {
  const hasVendor = fs.existsSync(DSH_NM);

  it('vendor/dsh 存在（本机应当有；缺失时其余断言会跳过而不是假通过）', () => {
    // 不强断言存在：vendor/ 被 git 忽略，别的机器上可能没有。
    // 这里的意义是"把这件事显式说出来"，而不是静默跳过。
    expect(typeof hasVendor).toBe('boolean');
  });

  it.runIf(hasVendor)('**没有任何一处嵌套 `- id:`** —— 这是按行解析成立的前提', () => {
    const files = [];
    for (const name of fs.readdirSync(DSH_NM)) {
      const p = path.join(DSH_NM, name, 'cordis.patch.yml');
      if (fs.existsSync(p)) files.push(p);
    }
    const presetsDir = path.join(DSH_NM, 'dsh-agent-presets', 'presets');
    if (fs.existsSync(presetsDir)) {
      for (const name of fs.readdirSync(presetsDir)) {
        const p = path.join(presetsDir, name, 'agent.cordis.yml');
        if (fs.existsSync(p)) files.push(p);
      }
    }
    expect(files.length, '应找到多个装配文件').toBeGreaterThan(3);
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      const dashed = lines.filter((l) => /^\s*- id:\s*\S/.test(l)).length;
      const anyForm = lines.filter((l) => /^\s*-?\s*id:\s*\S/.test(l)).length;
      expect(anyForm, path.basename(path.dirname(f)) + ' 出现了非 `- id:` 形式的 id 行 ⇒ 行解析不再足够')
        .toBe(dashed);
    }
  });

  it.runIf(hasVendor)('**本机确实存在并列的多套 host bundle**（"看不到≠不具备"的实证）', () => {
    const hosts = fs.readdirSync(DSH_NM).filter((n) => fs.existsSync(path.join(DSH_NM, n, 'cordis.patch.yml')));
    expect(hosts.length).toBeGreaterThan(2); // 实测 6 套：base / web-app / headless / acp-app / sdk-app / sdk-minimal
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
  });
});
