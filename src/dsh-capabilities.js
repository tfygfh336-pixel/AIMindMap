/* ============================================================
 * src/dsh-capabilities.js — DSH 能力边界（纯逻辑：解析装配清单 + 合成模型）
 * ------------------------------------------------------------
 * 为什么存在：`docs/EXTENSIONS.md` 写着「**AI 就是扩展机制**：长尾需求由 AI 组合现有原子能力
 * 动态完成」。这条哲学成立的前提是**知道原子能力有哪些** —— 否则会去为"其实已经有"的能力
 * 写新命令、装新插件、引新依赖。**这是唯一直接防"新增成本"的机制。**
 *
 * 已发生的真实误判：外部复核报告把 DSH 已经具备的 3 项能力判为"不具备"
 * （见 `10-信息文档` §5.5：能力表 12 行错 4 行）。成因是**取证来源是 README，而不是运行时装配**。
 *
 * ⇒ 本模块只读**两个机械来源**，两者都不可被文字误导：
 *   ① **装配文件**（`cordis.patch.yml` / `agent.cordis.yml`）—— 到底挂了什么；
 *   ② **磁盘包目录**（`node_modules/@deepseek-ai/`）—— 发行包里到底有什么。
 *
 * 由此得到三轴事实，缺一不可（**混淆任意两轴都会得出错误结论**）：
 *
 *   | 磁盘 | 被挂载 | 正确结论 |
 *   |------|--------|---------|
 *   | ✓ | ✓ 启用 | **当前可用** |
 *   | ✓ | 只在某层 `disabled: true` | **该层不用，但别处可能重挂**（见下） |
 *   | ✓ | 未被任何层挂载 | **存在但当前装配未启用**（可 profile 切换或 patch 挂载） |
 *   | ✗ | — | **不具备** |
 *
 * **最容易误判的两条规则（本模块存在的核心理由）**：
 *   1. host 平面（base / web）里 `disabled: true` **≠ 不可用** —— agent preset 会把同一 id 重挂；
 *   2. 装配文件里**没有** ≠ **不具备** —— 包可能就躺在磁盘上（例：`dsh-headless`、`dsh-schedule`、
 *      `dsh-mcp-client` 在这 6 个装配文件里一个都没出现，但三个包都在磁盘上）。
 *
 * 实现约束：**不引 YAML 解析**（工程零新依赖）。实测 6 个装配文件里没有任何一处嵌套 `- id:`，
 * 故按行解析足够 —— 该前提由单测 `tests/dsh-capabilities.test.js` 用真实文件断言。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMDshCapabilities = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ROW_RE = /^(\s*)- id:\s*(\S.*?)\s*$/;
  const NAME_RE = /^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/;
  const DISABLED_RE = /^\s*disabled:\s*true\s*$/;

  /**
   * 解析一个装配文件里的「挂载行」。
   * 每行是 `- id: <id>`，其后的 `name:` / `disabled:` 归属该行，直到下一个同类行。
   * `name` 可以为 null —— 那表示这一行**按 id 覆盖**上游同名行（patch 语义），不新引入包。
   * @param {string} text
   * @returns {Array<{id:string, name:string|null, disabled:boolean, line:number}>}
   */
  function parseMountRows(text) {
    const lines = String(text === undefined || text === null ? '' : text).split('\n');
    const rows = [];
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
      const m = ROW_RE.exec(lines[i]);
      if (m) {
        if (cur) rows.push(cur);
        cur = { id: m[2].replace(/^['"]|['"]$/g, ''), name: null, disabled: false, line: i + 1 };
        continue;
      }
      if (!cur) continue;
      const n = NAME_RE.exec(lines[i]);
      if (n && cur.name === null) { cur.name = n[1]; continue; }
      if (DISABLED_RE.test(lines[i])) cur.disabled = true;
    }
    if (cur) rows.push(cur);
    return rows;
  }

  /**
   * 归一化包名。实测两个来源的写法不同，**不归一化就会全错**：
   *   · 装配文件里写全名：`@deepseek-ai/dsh-tool-goal`
   *   · 磁盘目录只叫短名：`dsh-tool-goal`（因为都在 `node_modules/@deepseek-ai/` 下）
   * 子路径导出（`@deepseek-ai/dsh-headless/startup`）取第一段。
   */
  function shortName(name) {
    return String(name).replace(/^@deepseek-ai\//, '').split('/')[0];
  }

  /**
   * 合成能力边界模型。
   * @param {{layers:Array<{layer:string, kind:string, text:string}>, diskPackages:string[]}} input
   *   `kind`: `host`（host bundle，并列的几套）或 `preset`（agent 平面）
   */
  function buildModel(input) {
    const layers = [];
    const packageLayers = new Map(); // 短名 → [{layer, disabled}]
    const groups = [];               // 形如 `cordis:group` 的**合成分组**，不是包（去重记）
    for (const l of input.layers || []) {
      const rows = parseMountRows(l.text);
      const named = rows.filter((r) => r.name);
      layers.push({
        layer: l.layer,
        kind: l.kind,
        rows: rows.length,
        withName: named.length,
        overridesById: rows.length - named.length, // 只给 id 不给 name ⇒ 覆盖上游同名行
        disabled: rows.filter((r) => r.disabled).length
      });
      for (const r of named) {
        if (r.name.indexOf(':') >= 0) { // 合成分组，非包
          if (groups.indexOf(r.name) < 0) groups.push(r.name);
          continue;
        }
        const pkg = shortName(r.name);
        if (!packageLayers.has(pkg)) packageLayers.set(pkg, []);
        // 同一层内同一包可能多行（不同 id），去重按"层 + 是否 disabled"记
        const list = packageLayers.get(pkg);
        if (!list.some((x) => x.layer === l.layer)) list.push({ layer: l.layer, disabled: r.disabled });
        else if (!r.disabled) list.find((x) => x.layer === l.layer).disabled = false;
      }
    }
    const disk = (input.diskPackages || []).slice().sort();
    const diskSet = new Set(disk);
    const mounted = [...packageLayers.keys()].sort();
    return {
      layers,
      diskCount: disk.length,
      mounted,
      /** 在磁盘上、但**没有被任何装配层挂载** —— "存在但当前未启用" */
      unmounted: disk.filter((p) => !packageLayers.has(p)),
      /** 被挂载了、但**不在磁盘包目录**里（装配点名了不存在的包 ⇒ 值得警惕） */
      missingOnDisk: mounted.filter((p) => !diskSet.has(p)),
      groups,
      packageLayers
    };
  }

  /** 一个包在各层的状态：`启用` / `disabled` / `未出现` */
  function statusOf(model, pkg) {
    const hits = model.packageLayers.get(pkg);
    return {
      pkg,
      onDisk: model.unmounted.indexOf(pkg) >= 0 || !!hits,
      layers: hits || []
    };
  }

  const pad = (s, n) => String(s).padEnd(n);

  /**
   * 渲染文本报告。
   * @param {object} model buildModel 的产物
   * @param {{grep?:string, unmounted?:boolean, layer?:string}} [opts]
   */
  function renderReport(model, opts) {
    const o = opts || {};
    const out = [];
    out.push('DSH 能力边界（来源：vendor/dsh 的装配清单 + 磁盘包目录，均为机械读取）');
    out.push('');
    const hosts = model.layers.filter((l) => l.kind === 'host');
    out.push('⚠️ 四条容易误判的规则：');
    out.push('   1. host 平面里 disabled: true **≠ 不可用** —— agent preset 会把同一 id 重挂');
    out.push('   2. 装配文件里**没有** ≠ **不具备** —— 包可能就在磁盘上（未挂载：可换 profile 或 patch 挂载）');
    out.push('   3. 磁盘上**有** ≠ 当前可用 —— 未被挂载的包在当前 profile 里不生效');
    out.push('   4. **host bundle 是并列的、不是叠加的** —— 本机有 ' + hosts.length + ' 套（见下表 kind=host）。'
      + '`--profile X` 选其中一套；**在 web 平面看不到某能力，不等于不能做那件事** —— 它可能走另一套 bundle');
    out.push('');
    out.push('装配层（host bundle 与 agent preset 是两种东西，分开看）：');
    out.push('   类别   层                  行数  有 name  按 id 覆盖  disabled');
    for (const l of model.layers) {
      out.push('   ' + pad(l.kind, 7) + pad(l.layer, 19) + pad(l.rows, 6) + pad(l.withName, 9)
        + pad(l.overridesById, 11) + l.disabled);
    }
    out.push('');
    out.push('磁盘上的 @deepseek-ai 包：' + model.diskCount + ' 个'
      + '（已挂载 ' + model.mounted.length + ' / 未挂载 ' + model.unmounted.length + '）');
    if (model.groups.length) {
      out.push('   （另有 ' + model.groups.length + ' 处**合成分组**而非包，已排除在包统计外：'
        + model.groups.join(', ') + '）');
    }
    if (model.missingOnDisk.length) {
      out.push('   ⚠️ 装配点名但磁盘上没有的包（' + model.missingOnDisk.length + '）：'
        + model.missingOnDisk.join(', '));
    }

    if (o.grep) {
      const kw = String(o.grep).toLowerCase();
      const hits = [];
      out.push('');
      out.push('按关键词「' + o.grep + '」查（**两侧都查**：装配文件 + 磁盘包目录）：');
      for (const p of model.mounted) {
        if (p.toLowerCase().indexOf(kw) < 0) continue;
        const ls = model.packageLayers.get(p).map((x) => x.layer + (x.disabled ? '(disabled)' : '')).join(', ');
        hits.push('   ' + pad(p, 44) + '挂载于 ' + ls);
      }
      for (const p of model.unmounted) {
        if (p.toLowerCase().indexOf(kw) < 0) continue;
        hits.push('   ' + pad(p, 44) + '**磁盘上有，未被任何装配挂载**');
      }
      out.push(hits.length ? hits.join('\n') : '   （两层都没有匹配）');
      return out.join('\n');
    }

    if (o.unmounted) {
      out.push('');
      out.push('磁盘上有、但未被任何装配挂载的包（' + model.unmounted.length + ' 个）——');
      out.push('这些**存在于发行包**，只是当前 profile 没启用（可 profile 切换或 patch 挂载）：');
      for (const p of model.unmounted) out.push('   ' + p);
      return out.join('\n');
    }

    out.push('');
    out.push('提示：');
    out.push('   --grep <关键词>   查某个能力在不在、挂在哪层（两侧都查：装配 + 磁盘）');
    out.push('   --unmounted       列出"磁盘上有、但当前未挂载"的全部包');
    out.push('   --json            结构化输出（供程序消费）');
    return out.join('\n');
  }

  return { parseMountRows, buildModel, statusOf, renderReport, shortName };
});
