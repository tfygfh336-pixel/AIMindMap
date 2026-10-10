/* ============================================================
 * tests/cli-options.test.js — CLI 选项契约（registry 声明 ⇄ 解析器 ⇄ 报错文本）
 * ------------------------------------------------------------
 * 守的缺陷（2026-10-10 实测，非假设）：
 *   写命令对**不认识的选项静默忽略** —— `add <项目> root --topic X --tags aaa,bbb`
 *   打印"已添加"、退出码 0，而 `get` 里没有 tags、`stats` 的 taggedNodes 是 0。
 *   调用方是 AI，它把"0 + 成功话术"当依据 ⇒ 一次静默 = 一条假数据 + 一个自以为成功的 AI。
 *   `--tags` 在 `edit` / `add-image` 上**是合法选项**，跨命令误用极其自然，所以这条特别毒。
 *
 * 这一层守三件事（都是**纯逻辑/进程内**，不起子进程 —— 受限环境下管道 stdio 会 EPERM 假失败）：
 *   ① 声明自洽：usage（文档）⇄ options（判定）⇄ compatOptions（有意的兼容例外）；
 *   ② 解析与判定用**同一套归一规则**（`--detail-md` ↔ `detailMd`，`--key=value`）；
 *   ③ 报错文本必须**可照着改**：点名未知选项、给出支持集、跨命令误用点名，
 *      并且守门发生在**命令体之前**（由 cli-integration.js 的端到端断言再钉一遍）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const registry = require('../cli/registry.js');
const core = require('../cli/core.js');
const { invokeSync } = require('../cli/main.js');

/** 从 usage 字符串里抽出 `--x` token（kebab 写法） */
function usageTokens(usage) {
  return [...String(usage || '').matchAll(/--[a-z][a-z0-9-]*/g)].map((m) => m[0]);
}
/** kebab（`--detail-md`）→ camel（`detailMd`）——**复用**解析器那一套，别在测试里另写一份 */
const camel = (token) => core.optionKey(token);

describe('CLI 选项声明自洽（registry ⇄ usage）', () => {
  it('每条命令都声明了 options（数组；允许为空）', () => {
    const bad = registry.list().filter((c) => !Array.isArray(c.options)).map((c) => c.name);
    expect(bad).toEqual([]);
  });

  it('usage 里写到的每个选项都必须真的被接受（文档写了不能用 ⇒ 红）', () => {
    const bad = [];
    registry.list().forEach((c) => {
      const allowed = registry.allowedOptions(c.name);
      usageTokens(c.usage).forEach((tok) => {
        if (allowed.indexOf(camel(tok)) < 0) bad.push(c.name + ' → ' + tok);
      });
    });
    expect(bad).toEqual([]);
  });

  it('options 里的每一项都必须出现在 usage 里（实现了却没写文档 ⇒ 红）', () => {
    const bad = [];
    registry.list().forEach((c) => {
      const docs = usageTokens(c.usage).map(camel);
      registry.documentedOptions(c.name).forEach((k) => {
        if (docs.indexOf(k) < 0) bad.push(c.name + ' → --' + registry.kebab(k));
      });
    });
    expect(bad).toEqual([]);
  });

  it('compatOptions 必须**不**出现在 usage 里（否则它就该算正式选项）', () => {
    const bad = [];
    registry.list().forEach((c) => {
      const docs = usageTokens(c.usage).map(camel);
      (c.compatOptions || []).forEach((k) => {
        if (docs.indexOf(k) >= 0) bad.push(c.name + ' → --' + registry.kebab(k));
      });
    });
    expect(bad).toEqual([]);
  });

  it('read 的 --detail 是**有意的**兼容例外：仍被接受（文本模式响亮报错、--json 下空操作）', () => {
    expect(registry.allowedOptions('read')).toContain('detail');
    expect(registry.documentedOptions('read')).not.toContain('detail');
  });

  it('--compact 是派生出来的：只有会输出 JSON 的命令才接受它', () => {
    expect(registry.allowedOptions('read')).toContain('compact');
    expect(registry.allowedOptions('remove')).not.toContain('compact');
    expect(registry.allowedOptions('remove')).not.toContain('json');
  });

  it('别名与正式名共享同一套选项（tree → list、rm → remove）', () => {
    expect(registry.allowedOptions('tree')).toEqual(registry.allowedOptions('list'));
    expect(registry.allowedOptions('rm')).toEqual(registry.allowedOptions('remove'));
  });
});

describe('cli/core.js 选项归一与未知选项扫描（纯函数）', () => {
  it('--key=value 与 --key value 等价（`=` 形态以前会变成"键里带等号"的怪选项 ⇒ 静默）', () => {
    expect(core.parseArgs(['--expanded=nonsense']).expanded).toBe('nonsense');
    expect(core.parseArgs(['--expanded', 'nonsense']).expanded).toBe('nonsense');
    expect(core.parseArgs(['--detail-md', '# x']).detailMd).toBe('# x');
    expect(core.parseArgs(['--detail-md=# x']).detailMd).toBe('# x');
  });

  it('optionKey：kebab → camel，且与 parseArgs 的键名一致', () => {
    expect(core.optionKey('--detail-md')).toBe('detailMd');
    expect(core.optionKey('--expanded=nonsense')).toBe('expanded');
    expect(Object.keys(core.parseArgs(['--detail-md', 'x'])).indexOf('detailMd')).toBeGreaterThan(-1);
  });

  it('unknownOptions：只报不认识的；认识的、重复的、位置参数都不报', () => {
    expect(core.unknownOptions(['root', '--topic', 'X', '--tags', 'a,b'], ['topic']))
      .toEqual([{ key: 'tags', token: '--tags' }]);
    expect(core.unknownOptions(['--tags', 'a', '--tags', 'b'], ['topic'])).toHaveLength(1);
    expect(core.unknownOptions(['--bogus=1', '--bogus'], ['topic'])).toEqual([{ key: 'bogus', token: '--bogus' }]);
    expect(core.unknownOptions(['--topic=X'], ['topic'])).toEqual([]);
    expect(core.unknownOptions(['X'], [])).toEqual([]);
  });

  it('报错文本：点名未知选项 + 打印支持集 + 跨命令误用点名（AI 要据此改对）', () => {
    const msg = registry.unknownOptionError('add', [{ key: 'tags', token: '--tags' }]);
    expect(msg).toContain('--tags');
    expect(msg).toContain('add 不认识它');
    expect(msg).toContain('edit');              // 它能用的地方要点名
    expect(msg).toContain('--topic');           // 支持集整份打印
    expect(msg).toContain('用法：node cli/mm-cli.js add ');
  });

  it('报错文本：一个都不认识时也照样给出支持集（不空手报错）', () => {
    const msg = registry.unknownOptionError('remove', [{ key: 'bogus', token: '--bogus' }]);
    expect(msg).toContain('--bogus');
    expect(msg).toContain('--clean-links');
    expect(msg).not.toMatch(/是 .* 的选项/);     // 没有别的命令认识它 ⇒ 不编造提示
  });
});

describe('cli/core.js 整数选项（值非法不再静默退化）', () => {
  it('没给 ⇒ 返回默认值（含 undefined / null 两种既定默认语义）', () => {
    expect(core.parseIntOption(undefined, { def: 40 })).toEqual({ ok: true, value: 40 });
    expect(core.parseIntOption(undefined, { def: undefined })).toEqual({ ok: true, value: undefined });
    expect(core.parseIntOption(undefined, { def: null })).toEqual({ ok: true, value: null });
  });

  it('整数照收；越界/非整数/空值一律判非法（并说清允许范围）', () => {
    expect(core.parseIntOption('5', {})).toEqual({ ok: true, value: 5 });
    expect(core.parseIntOption('0', { min: 0 })).toEqual({ ok: true, value: 0 });
    expect(core.parseIntOption('-1', {})).toMatchObject({ ok: false });
    expect(core.parseIntOption('1.5', {})).toMatchObject({ ok: false });
    expect(core.parseIntOption('abc', {})).toMatchObject({ ok: false });
    expect(core.parseIntOption(true, {})).toMatchObject({ ok: false });     // 裸写 `--limit`
    expect(core.parseIntOption('', {})).toMatchObject({ ok: false });
    expect(core.parseIntOption('abc', {}).reason).toContain('非负整数');
    expect(core.parseIntOption('999', { max: 100 }).reason).toContain('100');
  });

  it('ctx.intOption：非法值经 ctx.error 抛错，且报错里写的是用户敲的那个 kebab 选项名', () => {
    const ctx = core.createContext(['x'], { command: 'orphans' });
    expect(ctx.intOption('limit', { def: 40 })).toBe(40);
    expect(ctx.intOption('limit2', {})).toBeUndefined();     // 没给 ⇒ undefined
    expect(() => core.createContext(['x', '--limit', 'abc'], { command: 'orphans' }).intOption('limit', { def: 40 }))
      .toThrow(/--limit 必须是非负整数/);
    expect(() => core.createContext(['x', '--min-length', 'x'], { command: 'mentions' }).intOption('minLength', { min: 1 }))
      .toThrow(/--min-length/);
  });
});

describe('CLI 未知选项的行为（进程内，命令体不得被调用）', () => {
  it('未知长选项 ⇒ exit 1 + error: 开头 + 支持集；且**命令体没跑**（报错不是"项目不存在"）', () => {
    const r = invokeSync(['add', 'no-such-project-xyz', 'root', '--topic', 'X', '--tags', 'a,b']);
    expect(r.code).toBe(1);
    expect(r.stdout.startsWith('error: ')).toBe(true);
    expect(r.stdout).toContain('未知选项 --tags');
    expect(r.stdout).not.toContain('项目不存在');
  });

  it('跨命令误用点名可用命令（add 不认识 --tags，但 edit / add-image 认识）', () => {
    const r = invokeSync(['add', 'no-such-project-xyz', 'root', '--topic', 'X', '--tags', 'a,b']);
    expect(r.stdout).toContain('edit');
    expect(r.stdout).toContain('add-image');
  });

  it('非法值形态（--expanded=nonsense）同样是 exit 1，不是静默落默认值', () => {
    const r = invokeSync(['edit', 'no-such-project-xyz', 'n1', '--expanded=nonsense']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('--expanded 只能是 true 或 false');
  });

  it('合法选项照旧通过：--expanded=false 会被解析成 false（不被当成字符串或默认值）', () => {
    expect(core.parseArgs(['--expanded=false']).expanded).toBe('false');
    // 走到"项目不存在"= 选项守门放行、命令体接管（顺序判据：守门在命令体之前）
    const r = invokeSync(['edit', 'no-such-project-xyz', 'n1', '--expanded=false']);
    expect(r.stdout).toContain('项目不存在');
  });

  it('`<命令> --help`：打印支持集且不执行命令（退出码 0）', () => {
    const r = invokeSync(['add', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('支持的选项:');
    expect(r.stdout).toContain('--topic');
    expect(r.stdout).toContain('用法: node cli/mm-cli.js add ');
  });
});
