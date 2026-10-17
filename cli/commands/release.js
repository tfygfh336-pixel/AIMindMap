/* ============================================================
 * cli/commands/release.js — 工程命令：docs-gen / changelog / release
 * ------------------------------------------------------------
 * docs-gen ：从 registry 重生成 docs/CLI.md（唯一文档源 = registry）
 * changelog：CHANGELOG **只读**窄查询（索引 / 关键词检索正文），不写盘、不落生成物
 * release  ：发版流程
 *   1) 读 CHANGELOG.md，把 [Unreleased] 段重命名为 vX.Y.Z
 *   2) 重建空的 [Unreleased] 段
 *   3) 更新 package.json / src/config.js / package-lock.json 版本
 *   4) 更新 README.md 版本锁（"当前版本：x.y.z" 与 build 路径）
 * 版本号计算已下沉到 src/version.js（纯函数，单测覆盖；顺带修正 --minor 不归零 patch）。
 * 约定：每次功能变更必须同步更新 CHANGELOG + README（双文档）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const version = require('../../src/version.js');
const changelogLib = require('../../src/changelog.js');
const dshCaps = require('../../src/dsh-capabilities.js');
const store = require('../../src/data-store.js');

const ROOT = path.resolve(__dirname, '..', '..');

/** 读一份**受管文档**，返回 `{file, text, version}` —— 关键是那个 `version`：
 *  它必须从**读的那一刻**带到**写的那一刻**，读写之间的任何别处写入才会被发现。
 *
 *  为什么不是"只读文本"（原先的形态）：`release` 是"读全部 → 改 → 整份覆写"，
 *  中间那段里别的会话可能已经改过 CHANGELOG（本工程常态：CHANGELOG 常驻"半暂存"状态）。
 *  只读文本时，那次改动会被**整份覆写静默抹掉**，而 CHANGELOG 是**只增**的历史资产 —— 丢的是历史。
 *  `opts.optional` ⇒ 文件不存在时不抛（生成物 `docs/CLI.md`、滚动归档新文件这两处需要）。 */
function read(rel, opts) { return store.readManagedText(path.join(ROOT, rel), opts); }

/** 写回受管文档：**本文件里唯一的写盘出口**。
 *
 *  它做三件事，且**三件都不许在这里重写**：
 *    ① 原子写（临时文件 + fsync + rename）→ `store.writeFileAtomic`（`docs/INCIDENTS.md` 派生禁令第 5 条）；
 *    ② 版本比对 → `store.versionGate`（与 `store.write` **同一份**比较逻辑；A1：只共用原语而各写一份比较不算共用）；
 *    ③ 冲突时**报出两侧指纹**并中止 → 同上。
 *  ⚠️ 这里不许出现第二段 `if (version !== …) throw`，也不许退回裸 `fs.writeFileSync`
 *     （那正是本批修掉的形态：实现违反了工程的自家禁令）。 */
function write(handle, content) {
  return store.writeManagedText(handle, content, {
    label: '受管文件「' + path.relative(ROOT, handle.file).split(path.sep).join('/') + '」',
    hint: '请重新读取该文件后再改（CHANGELOG.md 是只增的历史资产，整份覆写会丢历史）'
  });
}

/** 渲染 docs/CLI.md 的完整内容（纯函数，不写盘）。
 *  抽出来的唯一理由：让「生成物是否已过期」可以被机械检查 ——
 *  scripts/doc-facts.js 用同一函数重渲染并与磁盘上的 CLI.md 逐字比对，
 *  一旦有人改了 registry 却忘记跑 docs-gen，verify 直接变红（原来只靠自觉）。 */
function renderCliDoc() {
  const registry = require('../registry.js');
  const cmds = registry.list();
  const lines = [];
  /** 本文件的头部元信息（§5 登记表的数据源；与 docs/*.md 里的同格式） */
  const REGISTRY_HEADER_CLI = [
    '<!-- registry（本块是 §5 登记表的**数据源**；改完跑 `npm run docs:registry` 重新生成表）',
    '层: 契约',
    '作用: 命令参考',
    '不该写: —（**勿手改**）',
    '更新方式: `docs-gen` 生成（G7 校验）',
    '-->'
  ];
  lines.push('# CLI 参考（AI MindMap）');
  lines.push('');
  // 「文档头部元信息」由**生成器**产出（T5）：§5 登记表从各文档的这块元信息生成，
  // 生成物也必须自带，否则每次 docs-gen 都会把它抹掉、G8 立刻报「文档无元信息」。
  lines.push(...REGISTRY_HEADER_CLI);
  lines.push('');
  lines.push('> 本文件由 `node cli/mm-cli.js docs-gen` 从 cli/registry.js 自动生成。');
  lines.push('> **新增命令时修改 registry.js 后重跑 docs-gen**，勿手改本文件。');
  lines.push('');
  lines.push('## 通用');
  lines.push('');
  lines.push('- 入口：`node cli/mm-cli.js <command> [args...]`');
  lines.push('- `--json`：以 JSON 输出（供 AI / MCP 解析）');
  lines.push('- **失败：退出码非 0**（首选判据；脚本/CI 看这个），同时 stdout 输出 `error: <原因>`（文本辅助判据）');
  lines.push('- `validate` / `validate-all` 例外：输出结构化报告（`FAIL <项目>: …` 或 `--json` 的 `{ok,errors}`），同样以非 0 退出码表达失败');
  lines.push('- 项目名 = `projects/<name>/<name>.json` 的目录名');
  lines.push('');
  lines.push('## 命令一览');
  lines.push('');
  lines.push('| 命令 | 说明 |');
  lines.push('|------|------|');
  cmds.forEach((c) => {
    lines.push('| `' + c.name + '` | ' + (c.usage || c.desc) + ' |');
  });
  lines.push('');
  lines.push('## 详细用法');
  lines.push('');
  cmds.forEach((c) => {
    lines.push('### ' + c.name);
    lines.push('');
    lines.push((c.desc || '') + '');
    lines.push('');
    lines.push('```');
    lines.push('node cli/mm-cli.js ' + c.usage);
    lines.push('```');
    lines.push('');
  });
  return lines.join('\n');
}

module.exports = {
  docsGen(ctx) {
    const registry = require('../registry.js');
    const content = renderCliDoc();
    fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
    // 生成物也是受管资产 ⇒ 同样过闸门。读一次只为拿到"我读到的是哪一版"：
    // 生成与写回之间若有人手改过 docs/CLI.md，宁可拒绝并报出两侧指纹，也不静默抹掉。
    // `optional:true`：首次生成时文件还不存在（version=null ⇒ 闸门放行，与从前一致）。
    write(read('docs/CLI.md', { optional: true }), content);
    ctx.out('已重生成 docs/CLI.md（' + registry.list().length + ' 条命令）');
  },

  // 供 scripts/doc-facts.js 做「生成物是否过期」检查（非命令）
  renderCliDoc,

  /** CHANGELOG 窄查询（**只读，不写盘**）：给出段/条目索引，或按关键词检索正文。
   *  为什么需要：见 src/changelog.js 的 indexChangelog 注释 —— CHANGELOG 只增不减、必然越来越长，
   *  而「上轮改了什么」是最常被问的问题，且 git 侧无替代入口。
   *  索引从正文**现算**，不落生成物 ⇒ 永不漂移，也不需要额外维护步骤。 */
  changelog(ctx) {
    const text = read('CHANGELOG.md').text;
    const idx = changelogLib.indexChangelog(text);
    const srcLines = text.split('\n');
    const kw = (ctx.args.grep === undefined || ctx.args.grep === true) ? null : String(ctx.args.grep);
    const full = !!ctx.args.full;
    // --limit：非法值当场报错（`--limit abc` 以前会被 `parseInt(...) || 0` 静默变成"限 0 条" = 空索引）
    const limit = ctx.intOption('limit', { min: 0, def: null });
    const kwLc = kw === null ? null : kw.toLowerCase();
    const totalEntries = idx.sections.reduce((n, s) => n + s.entries.length, 0);

    /** 取条目的正文（1 起行号 + 行数） */
    const bodyOf = (e) => srcLines.slice(e.startLine - 1, e.startLine - 1 + e.lines).join('\n');

    // 选取命中条目（无关键词 = 全选）
    const groups = [];
    let matched = 0;
    for (const sec of idx.sections) {
      const hit = sec.entries.filter((e) => kwLc === null
        || e.heading.toLowerCase().includes(kwLc)
        || bodyOf(e).toLowerCase().includes(kwLc));
      // 索引模式（无关键词）：**空段也要列**（例如刚发版后的 `[Unreleased]` 只剩占位行）——
      // 否则"本文件现在有哪些段"看不全；检索模式：无命中不列（收窄才有意义）。
      if (!hit.length && kwLc !== null) continue;
      groups.push({ sec, entries: hit });
      matched += hit.length;
    }
    // --limit：按文件顺序（新在前）截断
    if (limit !== null) {
      let left = limit;
      const trimmed = [];
      for (const g of groups) {
        if (left <= 0) break;
        const take = g.entries.slice(0, left);
        left -= take.length;
        trimmed.push({ sec: g.sec, entries: take });
      }
      groups.length = 0;
      for (const g of trimmed) groups.push(g);
    }

    // 归档检索：**主文件 + docs/changelog/ 一起搜**。
    // 补这个缺口的理由见 src/changelog.js 的 searchArchives 注释：
    // 只搜主文件时，已归档的历史查不到，用起来就像"历史丢了"。
    const archDir = path.join(ROOT, 'docs', 'changelog');
    const arch = changelogLib.searchArchives(archDir, kw);

    if (ctx.args.json) {
      ctx.outJson({
        totalLines: idx.totalLines,
        totalBytes: idx.totalBytes,
        sections: idx.sections.length,
        entries: totalEntries,
        grep: kw,
        matched,
        groups: groups.map((g) => ({
          version: g.sec.version,
          date: g.sec.date,
          heading: g.sec.heading,
          entries: g.entries.map((e) => ({ heading: e.heading, startLine: e.startLine, lines: e.lines, bytes: e.bytes }))
        })),
        archived: {
          totalHits: arch.totalHits,
          files: arch.files.map((a) => ({
            file: a.file, version: a.version, date: a.date,
            hits: a.hits.map((h) => ({ line: h.line, heading: h.heading, text: h.text }))
          }))
        }
      });
      return;
    }

    ctx.out(kw === null
      ? 'CHANGELOG 索引 — ' + idx.totalLines + ' 行 / ' + idx.totalBytes + ' B ｜ '
        + idx.sections.length + ' 段 / ' + totalEntries + ' 条目'
      : 'CHANGELOG 检索「' + kw + '」— 主文件命中 ' + matched + ' 条目 / ' + groups.length + ' 段'
        + '；归档命中 ' + arch.totalHits + ' 处 / ' + arch.files.length + ' 份'
        + (limit !== null ? '（--limit ' + limit + '）' : ''));
    if (!full) ctx.out('（--grep 关键词 检索（含归档）· 加 --full 连正文一起给 · --limit n 限条数）');
    // 归档命中逐条列出（这是"查得到历史"的关键：主文件查不到的，在这里给出行号）
    arch.files.forEach((a) => {
      ctx.out('');
      ctx.out('[归档 ' + a.version + (a.date ? ' · ' + a.date : '') + ']  docs/changelog/' + a.file
        + '  —  ' + a.hits.length + ' 处命中');
      a.hits.forEach((h) => {
        ctx.out('  L' + String(h.line).padEnd(5) + '〔' + h.heading.slice(0, 40) + '〕 ' + h.text);
      });
    });
    // 更老的版本段已滚动归档：主文件里查不到时，别以为"没发生过"，去归档目录找
    try {
      const files = fs.existsSync(archDir) ? fs.readdirSync(archDir).filter((f) => /\.md$/.test(f)) : [];
      if (files.length) {
        ctx.out('');
        ctx.out('已归档的历史版本段：docs/changelog/（' + files.length + ' 份，'
          + files.sort().join(' / ') + '）');
      }
    } catch (e) { /* 归档目录不可读不影响查询 */ }
    ctx.out('');

    for (const g of groups) {
      ctx.out(g.sec.heading + '  —  ' + g.sec.lines + ' 行 / ' + g.sec.bytes + ' B');
      for (const e of g.entries) {
        ctx.out('  L' + String(e.startLine).padEnd(5) + String(e.lines).padStart(5) + '行  '
          + String(e.bytes).padStart(7) + ' B  ' + e.heading);
        if (full) {
          ctx.out('');
          ctx.out(bodyOf(e).replace(/\s+$/, ''));
          ctx.out('');
        }
      }
      ctx.out('');
    }
  },

  /** DSH 能力边界（**只读**）：从 `vendor/dsh` 的装配清单 + 磁盘包目录**机械读取**。
   *  为什么需要：防止为"其实已经有"的能力写新命令 / 装新插件（见 `src/dsh-capabilities.js` 顶部）。
   *  两条最容易误判的规则也在那里：host 平面 `disabled: true` **≠ 不可用**；
   *  装配文件里**没有** ≠ **不具备**（包可能就在磁盘上）。 */
  dshCaps(ctx) {
    const nm = path.join(ROOT, 'vendor', 'dsh', 'app', 'node_modules', '@deepseek-ai');
    if (!fs.existsSync(nm)) {
      ctx.error('找不到 DSH 运行时包目录：' + nm
        + '\n（`vendor/dsh` 是桌面侧栏用的本地运行包、被 git 忽略；本命令依赖它，属已知边界）');
    }
    const a = ctx.args;
    if (a.grep === true) ctx.error('--grep 需要一个关键词：dsh-caps --grep 关键词');

    // ---- host 平面：凡带 cordis.patch.yml 的包（实测为 dsh-base 与 dsh-web-app）----
    // 自动发现而非硬编码路径 —— 将来多一个 host bundle 会自动进入统计，不会被静默漏掉。
    const layers = [];
    for (const name of fs.readdirSync(nm).sort()) {
      const p = path.join(nm, name, 'cordis.patch.yml');
      if (fs.existsSync(p)) layers.push({ layer: name, kind: 'host', text: fs.readFileSync(p, 'utf8') });
    }
    // ---- agent 平面：presets/<name>/agent.cordis.yml（同样自动发现）----
    const presetsDir = path.join(nm, 'dsh-agent-presets', 'presets');
    if (fs.existsSync(presetsDir)) {
      for (const name of fs.readdirSync(presetsDir).sort()) {
        const p = path.join(presetsDir, name, 'agent.cordis.yml');
        if (fs.existsSync(p)) {
          layers.push({ layer: 'preset:' + name, kind: 'preset', text: fs.readFileSync(p, 'utf8') });
        }
      }
    }
    if (!layers.length) {
      ctx.error('在 ' + nm + ' 下没找到任何装配文件（cordis.patch.yml / agent.cordis.yml）');
    }

    const diskPackages = fs.readdirSync(nm).filter((n) => {
      try { return fs.statSync(path.join(nm, n)).isDirectory(); } catch (e) { return false; }
    });
    const model = dshCaps.buildModel({ layers, diskPackages });

    if (a.json) {
      // Map 不能直接 stringify ⇒ 转成「包 → 各层状态」的数组
      ctx.outJson({
        layers: model.layers,
        diskCount: model.diskCount,
        mountedCount: model.mounted.length,
        unmountedCount: model.unmounted.length,
        missingOnDisk: model.missingOnDisk,
        unmounted: model.unmounted,
        packages: model.mounted.map((p) => ({ pkg: p, layers: model.packageLayers.get(p) }))
      });
      return;
    }
    ctx.out(dshCaps.renderReport(model, {
      grep: a.grep === undefined ? null : String(a.grep),
      unmounted: !!a.unmounted
    }));
  },

  release(ctx) {
    const pkgH = read('package.json');
    const pkg = JSON.parse(pkgH.text);
    let next = ctx.args._[0];
    if (!next) {
      // 递增逻辑在 src/version.js（纯函数）：低位一律归零。
      // 历史缺陷：--minor 只加 minor 不归零 patch（0.14.3 → 0.15.3），
      // 且没有 --major。现由 bump() 统一处理并被单测锁住。
      const kind = ctx.args.major ? 'major' : (ctx.args.minor ? 'minor' : 'patch');
      next = version.bump(pkg.version || '0.0.0', kind);
      if (!next) ctx.error('package.json 的 version 非法，无法自增: ' + pkg.version);
    }
    if (!version.isValid(next)) ctx.error('版本号格式: x.y.z');
    // 防回退：把 0.15.0 发到已存在的 0.16.0 会让版本号倒退
    const cmp = version.compare(next, pkg.version || '0.0.0');
    if (cmp !== null && cmp <= 0) {
      ctx.error('新版本号必须大于当前版本 ' + pkg.version + '（否则版本倒退）');
    }

    // 1) CHANGELOG：[Unreleased] → [vX.Y.Z]（变换在 src/changelog.js，纯函数、有单测）
    //    ⚠️ `clH` 是**读的那一刻**的句柄：写回时把它的 version 交给闸门。这是本命令最关键的一处 ——
    //    CHANGELOG 只增不减，整份覆写丢掉的是历史。
    const clH = read('CHANGELOG.md');
    let changelog = clH.text;
    try {
      changelog = changelogLib.releaseChangelog(changelog, next, new Date().toISOString().slice(0, 10));
    } catch (err) {
      ctx.error((err && err.message) || err);
    }
    // 1b) 滚动归档：主文件只留最近 KEEP_RELEASED_SECTIONS 个已发版本段，
    //     更老的整段移入 docs/changelog/<版本>.md（只增不改，G6 不扫、G8 前缀放行）。
    //     放在发版流程里 ⇒ 不新增需要人记住的步骤（滚动的唯一触发点）。
    let archivedCount = 0;
    try {
      const split = changelogLib.splitChangelog(changelog, changelogLib.KEEP_RELEASED_SECTIONS);
      split.archived.forEach((a) => {
        const rel = 'docs/changelog/' + a.version + '.md';
        fs.mkdirSync(path.join(ROOT, 'docs', 'changelog'), { recursive: true });
        // optional：归档文件通常还不存在（version=null ⇒ 闸门放行）；已存在时则真的比对，
        // 免得同一版本段被两次发版写成不同内容而没人发现。
        write(read(rel, { optional: true }), changelogLib.renderArchiveFile(a, changelogLib.KEEP_RELEASED_SECTIONS));
        archivedCount++;
      });
      changelog = split.main;
    } catch (err) {
      ctx.error('滚动归档失败：' + ((err && err.message) || err));
    }
    write(clH, changelog);

    // 2) package.json version + src/config.js APP_VERSION + package-lock.json
    //    版本号单源：这三处必须一致，否则运行时（渲染层/CLI init 写 meta.version）
    //    与打包产物版本会互相矛盾。
    pkg.version = next;
    write(pkgH, JSON.stringify(pkg, null, 2) + '\n');

    const cfgH = read('src/config.js');
    const cfgNext = cfgH.text.replace(/APP_VERSION:\s*'[^']*'/, "APP_VERSION: '" + next + "'");
    if (cfgNext === cfgH.text) ctx.error('src/config.js 未找到 APP_VERSION 字段，无法同步版本号');
    write(cfgH, cfgNext);

    // package-lock.json 的顶层与 packages[""] 两处 version
    let lockH = null;
    let lock = null;
    try { lockH = read('package-lock.json'); lock = JSON.parse(lockH.text); } catch (e) { lock = null; lockH = null; }
    if (lock) {
      lock.version = next;
      if (lock.packages && lock.packages['']) lock.packages[''].version = next;
      write(lockH, JSON.stringify(lock, null, 2) + '\n');
    }

    // 3) README 版本锁
    const readmeH = read('README.md');
    let readme = readmeH.text;
    readme = readme.replace(/当前版本：[\d.]+/g, '当前版本：' + next);
    readme = readme.replace(/AIMindMap-[\d.]+-setup\.exe/g, 'AIMindMap-' + next + '-setup.exe');
    write(readmeH, readme);

    ctx.out('已发版 v' + next
      + '（CHANGELOG 段落 + package.json + src/config.js + package-lock.json + README 版本锁）'
      + (archivedCount ? '；已滚动归档 ' + archivedCount + ' 个历史版本段 → docs/changelog/' : ''));
    // 交接面提醒：按 §5 准入第 5 条，「在飞 / 未收口」小节在发版时必须清空或移入版本段。
    // 这里只**提醒**（不代改）—— 该小节是给下一个接手的 AI 看的，清空前要人/AI 判断哪些还没收口。
    try {
      const rm = read('docs/ROADMAP.md').text;
      const seg = rm.split(/^##\s/m).find((s) => /在飞\s*\/\s*未收口/.test(s.split('\n')[0] || ''));
      const rows = seg ? (seg.match(/^\|\s*(在飞|已收口)\s*\|/gm) || []).length : 0;
      if (rows > 0) {
        ctx.out('⚠️ 交接面提醒：`docs/ROADMAP.md`「在飞 / 未收口」还有 ' + rows
          + ' 条记录 —— 按 §5 准入第 5 条，发版时应清空或移入版本段（把已收口的删掉，在飞的留给下一位）。');
      }
    } catch (e) { /* ROADMAP 不可读不影响发版 */ }
  }
};
