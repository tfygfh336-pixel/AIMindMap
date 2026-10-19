/* ============================================================
 * cli/commands/merge.js — `merge-project`：把若干个项目**整棵并进**一个已有项目
 * ------------------------------------------------------------
 * 为什么要有它（2026-10-19）：`move` / `clone` 都只收**一个**项目名（单项目内），
 * `import-project` / `import-dir` 建的是**新项目**，没有一个命令能"把 7 本书的树并进主项目"。
 * 手工做只有一条路 —— 直接改 JSON，而那正是 `docs/AI-GUIDE.md` §数据纪律 16 行禁止的事
 *（校验闸门在 CLI 里，绕过它就写出非法数据）。
 *
 * ## 分工（与 `src/links.js` ↔ `cli/commands/links.js` 同一个分工）
 * 判据、id 处理、边改指、幂等、节点数自检 **全在** `src/merge-project.js`（纯逻辑，可单测）；
 * 本文件只做三件事：**读盘 → 调它 → 回显**。
 * 写盘走 `ctx.mutate(fn)` ⇒ 版本闸门 / 并发重放 / 写盘前校验 / 一次原子写 / `--dry-run`
 * 中央短路，全部复用既有机制，这里一条都不重写。
 *
 * ## `--dry-run` 与真跑**同一份判据**（不是"另写一份预览"）
 * `ctx.mutate` 的 dry-run 分支是"在内存里的一份拷贝上跑**同一个** fn，再跑**同一个**
 * `validateBeforeWrite`"⇒ 本命令的每一条拒绝（父节点不存在 / id 撞号 / 已合并过 / 边核验不过…）
 * 在预览期**照原样抛出、报文逐字相同**，而且预览期一个字节都不写。
 * 这是"预览说能成 ⇒ 真跑必能成"的**构造保证**，不是两边各写一份口径再祈祷它们一致。
 *
 * ## 源项目**默认保留**，且本命令**不删任何东西**
 * 合并是"复制一棵树进去"，源项目原封不动（它在 `projects/` 下的那份 JSON 一个字节都没变）。
 * 合并后的"撤销"是一条既有命令：`remove <目标项目> <分组节点id>` —— 删整棵子树、一次原子写。
 * 刻意**不给** `--remove-source` 之类的开关：删项目是另一个危险动作，不该长在合并命令上。
 *
 * ⚠️ 命令体里不得出现 `await`（`cli/main.js` 的 `invokeSync` 依赖这条不变量，
 *    `tests/cli-sync-invariant.test.js` 静态把守）。
 * ============================================================ */
'use strict';

const mergeProject = require('../../src/merge-project.js');

/** 位置参数：`merge-project <目标项目> <源项目…>` —— `ctx.args._[0]` 是目标（= `ctx.projectName`） */
function sourceNamesOf(ctx) {
  return (Array.isArray(ctx.args._) ? ctx.args._ : []).slice(1)
    .map((s) => String(s))
    .filter((s) => s !== '');
}

/** `--links` 归一：不给 = `keep`；裸写 `--links`（被解析成 `true`）响亮拒绝，别猜成 keep */
function linksModeOf(ctx) {
  const raw = ctx.args.links;
  if (raw === undefined || raw === null) return 'keep';
  if (raw === true) {
    ctx.error('--links 需要一个值：`--links ' + mergeProject.LINKS_MODES.join('` 或 `--links ') + '`'
      + '（keep = 边原样带走，默认；repoint = 把指向本次合并源的边改指到目标项目）');
  }
  const v = String(raw);
  if (mergeProject.LINKS_MODES.indexOf(v) < 0) {
    ctx.error('--links 只认 ' + mergeProject.LINKS_MODES.join(' / ') + '（收到 ' + JSON.stringify(raw) + '）'
      + ' —— keep = 边原样带走（默认；源项目默认保留 ⇒ 不悬挂）；'
      + 'repoint = 把"指向本次合并进来的源项目"的边改指到目标项目（逐条核验，一条不过就整条命令拒绝）');
  }
  return v;
}

/** `--group-id` 归一：只给**单源**用（多源时每个分组节点的 id 由源项目名派生，一个值不够分） */
function groupIdOfFactory(ctx, sources) {
  const raw = ctx.args.groupId;
  if (raw === undefined || raw === null) return null;
  if (raw === true) ctx.error('--group-id 需要一个值：`--group-id <节点id>`（小写字母/数字/连字符）');
  if (sources.length > 1) {
    ctx.error('--group-id 只适用于**一次合并一个源项目**（这次给了 ' + sources.length + ' 个：'
      + sources.join('、') + '）—— 多源时分组节点 id 由源项目名自动派生（`' + mergeProject.GROUP_PREFIX
      + '<源项目名>`），一个 --group-id 分不出 7 个名字。要自定分组 id 请逐个源分开合并');
  }
  const v = String(raw);
  return function () { return v; };
}

/** 一行"共 N 条"的边去向（文本档与 --json 共用同一份读数，不各算一遍） */
function linkLine(links, groups) {
  const parts = [];
  parts.push('指向目标项目 ' + links.toTarget + ' 条（合并后即项目内自指边，无需改指）');
  if (links.repointed) {
    const by = Object.keys(links.repointedByProject || {});
    parts.push('已改指 ' + links.repointed + ' 条 → 目标项目内同 id'
      + (by.length ? '（' + by.map((k) => k + ' ' + links.repointedByProject[k]).join(' / ') + '）' : ''));
  } else if (links.toMerged) {
    parts.push('指向本次也合并进来的源项目 ' + links.toMerged + ' 条 —— `--links keep`：**原样带走**'
      + '（源项目默认保留 ⇒ 不会悬挂；要保持自包含请加 `--links repoint`）');
  }
  if (links.toOutside) {
    const by = Object.keys(links.outsideProjects || {});
    parts.push('指向本次合并之外的 ' + links.toOutside + ' 条（' + by.join(' / ') + '，与合并无关，原样保留）');
  }
  if (links.noProject) parts.push('缺 project 的边 ' + links.noProject + ' 条（那是坏数据，`validate` 会判红）');
  return parts.join(' · ');
}

module.exports = {
  mergeProject(ctx) {
    const targetName = ctx.projectName;
    if (!targetName) {
      ctx.error('缺少目标项目名 —— 用法：merge-project <目标项目> <源项目…> [--parent <id>] '
        + '[--links ' + mergeProject.LINKS_MODES.join('|') + '] [--group-id <id>] [--dry-run] [--json]');
    }
    const sources = sourceNamesOf(ctx);
    if (!sources.length) {
      ctx.error('缺少源项目 —— 用法：merge-project ' + targetName + ' <源项目…> [--parent <id>] '
        + '[--links ' + mergeProject.LINKS_MODES.join('|') + '] [--dry-run] [--json]'
        + '；现有项目用 `projects` 列');
    }
    /* 位置参数的三道闸门都在**读盘之前**：它们不需要看盘，早报早省事 */
    const dup = sources.filter((n, i) => sources.indexOf(n) !== i);
    if (dup.length) {
      ctx.error('源项目重复给了: ' + [...new Set(dup)].join('、') + ' —— 同一个项目在一次合并里只能出现一次'
        + '（两次会把同一批 id 带进来，判据会以"id 撞号"整体拒绝）');
    }
    if (sources.indexOf(targetName) >= 0) {
      ctx.error('源项目不能是目标项目本身（' + targetName + '）—— 把项目并进自己会让每一个 id 都撞上自己；'
        + '要"再造一枝"请用 `clone ' + targetName + ' <源节点id> <新父节点id> --deep`');
    }

    const linksMode = linksModeOf(ctx);
    const groupIdOf = groupIdOfFactory(ctx, sources);
    const parentId = (ctx.args.parent === undefined || ctx.args.parent === null || String(ctx.args.parent) === '')
      ? 'root' : String(ctx.args.parent);

    /* 源项目必须先**都读得出来**：一个读不了就整条命令不做 ——
     * "6 个成功 1 个失败"是最坏的那种结局（人以为 7 本都进去了，而回显只有一行 exit 1）。 */
    const known = ctx.store.list().map((p) => p.name);
    const missing = sources.filter((n) => known.indexOf(n) < 0);
    if (missing.length) {
      ctx.error('源项目不存在: ' + missing.join('、') + ' —— `projects/` 下现有：' + known.join('、'));
    }
    const pre = ctx.read();                       // 目标项目读不到 ⇒ 这里就响亮报（路径与其它命令同一处）
    const srcData = sources.map((n) => ({ name: n, data: ctx.store.read(n).data }));

    let report = null;
    const res = ctx.mutate((cur) => {
      /* ⚠️ fn 里**不做 I/O、不打印**：并发冲突时它会被再调一次（源数据已读进闭包，这里只做纯计算）。
       * `--dry-run` 时 `cur` 是内存拷贝 ⇒ 同一个函数跑出同一份判据与同一份读数。 */
      const r = mergeProject.mergeProjectData({
        target: { name: targetName, data: cur },
        sources: srcData,
        parentId: parentId,
        linksMode: linksMode,
        groupIdOf: groupIdOf || undefined
      });
      if (!r.ok) throw new Error(r.message);
      report = r;
      return r.data;
    });

    const totals = report.totals;
    const groups = report.groups;
    /* 分组子树的展开态：源根 7 本里 7 个都是 expanded:true ⇒ 合并后每本书一眼展开到一级主题，
     * 再往下的层级沿用源项目自己的折叠态（逐字带走，不是本命令的取舍）。 */
    const expandedGroups = groups.filter((g) => g.rootExpanded).length;

    if (ctx.args.json) {
      ctx.outJson({
        ok: true,
        merged: !ctx.dryRun,
        target: targetName,
        parent: totals.parent,
        linksMode: totals.linksMode,
        groups: groups,
        totals: totals,
        attempts: res.attempts,
        autoReplayed: res.merged === true
      });
      return;
    }

    ctx.out('合并' + (ctx.dryRun ? '预览' : '完成') + '：' + groups.length + ' 个源项目 / '
      + totals.sourceNodes + ' 个节点 → 目标项目 ' + targetName + '（挂在父节点 ' + totals.parent + ' 下）');
    ctx.out('分组节点（每个源一个；它就是**源项目的根节点**，只把 id 换成确定性的 `'
      + mergeProject.GROUP_PREFIX + '<源项目名>`）：');
    groups.forEach((g) => {
      /* 主题原样打印，**不**包《》—— 源根的主题本身往往已经带书名号与后缀
       *（实测 7 本都是 `《…》知识点大纲`，再包一层会变成 `《…》知识点大纲》`）。 */
      ctx.out('  ' + g.groupId + '  ' + String(g.groupTopic || '（无主题）') + '  '
        + g.nodes + ' 节点（携带 ' + g.carried + ' + 根 1）'
        + (g.originNodes ? '  origin ' + g.originNodes : '')
        + (g.rootExpanded ? '  expanded' : ''));
    });
    ctx.out('节点数：' + totals.targetNodesBefore + ' → ' + totals.targetNodesAfter
      + '（+' + totals.addedNodes + '；源项目合计 ' + totals.sourceNodes + ' —— 逐条相符 ✓）');
    ctx.out('条目：' + totals.items + ' 条（条目 id 的**全项目唯一性**已逐条核验，无撞号）');
    ctx.out('origin：并入的节点里有 ' + totals.originNodes + ' 个带 origin'
      + '（`src`/`sha256`/`at`/`tool` **逐字原样带走**，一个字都没重算 —— 它是溯源，不是指纹）');
    ctx.out('边 links[]（合并进来的子树内）：' + linkLine(totals.links, groups));
    ctx.out('子树**之外**指向本次合并源的边：' + totals.outsideSubtreeEdgesIntoMergeSet.length
      + ' 条' + (totals.outsideSubtreeEdgesIntoMergeSet.length
        ? '（' + totals.outsideSubtreeEdgesIntoMergeSet.slice(0, 10).map((e) => e.node + '→' + e.project + '/' + e.id).join('、')
          + '）—— 本命令只动合并进来的那棵子树，这些边**没动**，要一并改指请单独处理'
        : '（本命令不动合并范围之外的数据）'));
    /* R5 连带面：目标项目若是"主题分侧"模式，新并入的顶层主题落在哪一侧是**用户能看见**的事 */
    const tgtMeta = (pre.data && pre.data.meta) || {};
    if (tgtMeta.rootMode === 'themes' && totals.parent === String(pre.data.data.id)) {
      const left = (tgtMeta.layout && Array.isArray(tgtMeta.layout.left)) ? tgtMeta.layout.left.length : 0;
      ctx.out('提示：目标项目是**主题分侧**模式（`meta.rootMode='
        + JSON.stringify(tgtMeta.rootMode) + '`，`layout.left` 现有 ' + left
        + ' 个主题）⇒ 新并入的 ' + groups.length + ' 个顶层主题默认排在**右侧**；'
        + '要分侧用 `theme-layout ' + targetName + ' --left a,b --right c,d`');
    }
    if (expandedGroups) {
      ctx.out('展开态：' + expandedGroups + '/' + groups.length + ' 个分组节点沿用源根的 `expanded:true`'
        + '（更深的层级逐字沿用源项目自己的折叠态）');
    }
    ctx.out('撤销：`remove ' + targetName + ' <分组节点id>` 逐棵删回（删整棵子树、一次原子写；'
      + '分组节点：' + groups.map((g) => g.groupId).join('、') + '）—— 源项目**一个字节都没动**');
    if (linksMode === 'repoint' && totals.links.repointed) {
      /* 如实说（实测过）：repoint 之后这些边成了**目标项目内的自指边** ⇒ 删"被指的那几个分组"
       * 会被 `remove` 的"有人引用我"守卫挡一次（exit 1 并逐条点名那 12 条），要加 `--clean-links`。
       * 不写这一句，回显就是在承诺一件会失败的事。 */
      ctx.out('注意：`--links repoint` 之后有 ' + totals.links.repointed
        + ' 条边改成了目标项目内的自指边 ⇒ 先删**被指的那几个分组**（'
        + Object.keys(totals.links.repointedByProject || {}).join('、')
        + '）时 `remove` 会挡一次并逐条点名，那时加 `--clean-links` 即可；'
        + '**反序删**（先删发起方）则不需要');
    }
    if (ctx.dryRun) ctx.out('（以上是预览：真跑会把上面这份改动一次原子写落盘）');
  }
};
