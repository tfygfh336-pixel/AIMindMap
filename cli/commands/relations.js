/* ============================================================
 * cli/commands/relations.js — 引用关系命令
 * ------------------------------------------------------------
 *   backlinks <项目> <id> [--json]
 *     单向：谁引用了我 —— within（本项目）/ cross（其他项目）
 *   related <项目> <id> [--json] [--depth N]
 *     双向聚合：我引用谁（out）+ 谁引用我（in），互相引用记为 both
 *     --depth N = N 跳邻域（任意正整数；2 = 间接关联的知识簇，对应 Obsidian 的局部图）；
 *     防环（每节点只以最短跳数入表一次）+ 结果上限（超限响亮报错，见 related 的注释）；
 *     刻意**不做全量图谱**（已在 docs/ROADMAP.md 否决）
 *   orphans <项目> [--json] [--content-only] [--limit n]
 *     关系审计：找出「无任何引用关系」的节点，并把其中**含实质内容**的挑出来
 *     —— 那才是真正该处理的部分（纯结构型叶子节点无内容是正常的，不算问题）。
 *   mentions <项目> [--json] [--min-length n] [--include-structural] [--cross] [--limit n]
 *     未链接提及：正文**提到了**某节点却没有为它建 links —— orphans 缺失的另一半。
 *     --cross 额外扫描跨项目两个方向（in/out），同名歧义不猜、照报并标记
 * 计算逻辑在 src/relations.js 与 src/mentions.js（UMD，单测覆盖纯部分；本项目做 fs 注入）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const relations = require('../../src/relations.js');
const mentions = require('../../src/mentions.js');

/** 读取全部项目（{ name, data }），供跨项目反查 */
function loadAllProjects(PROJECTS_DIR) {
  const out = [];
  if (!fs.existsSync(PROJECTS_DIR)) return out;
  fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .forEach((e) => {
      const f = path.join(PROJECTS_DIR, e.name, e.name + '.json');
      if (!fs.existsSync(f)) return;
      try { out.push({ name: e.name, data: JSON.parse(fs.readFileSync(f, 'utf8')) }); }
      catch (err) { /* 跳过坏项目 */ }
    });
  return out;
}

function arrowOf(dir) {
  if (dir === 'out') return '→';
  if (dir === 'in') return '←';
  return '↔';
}

module.exports = {
  backlinks(ctx) {
    const id = ctx.args._[1];
    if (!id) ctx.error('用法: backlinks <项目> <id> [--json]');
    const { data } = ctx.read();
    const target = ctx.tree.find(data.data, id);
    if (!target) ctx.error('节点不存在: ' + id);
    const all = loadAllProjects(ctx.PROJECTS_DIR);
    const r = relations.backlinksAll(ctx.projectName, id, all);
    const out = { project: ctx.projectName, target: { id, topic: target.topic }, ...r };
    if (ctx.args.json) { ctx.outJson(out); return; }
    ctx.out('「' + target.topic + '」的反向链接：');
    if (!r.within.length && !r.cross.length) ctx.out('  （暂无节点引用它）');
    r.within.forEach((x) => ctx.out('  [本项目] ' + x.node + '  ' + x.topic + (x.caption ? '  — ' + x.caption : '')));
    r.cross.forEach((x) => ctx.out('  [' + x.project + '] ' + x.node + '  ' + x.topic + (x.caption ? '  — ' + x.caption : '')));
  },

  /**
   * 「相关知识点」：双向邻域，**深度任意**（用户要的"多跳关系可查"是卖点原话）。
   *
   * 修前实测（2026-10-10）：`--depth` 只认 1 或 2，其它值**静默退化成 1**
   * （`related <项目> <id> --depth 3 --json` ⇒ `"depth": 1`，看起来成功其实是另一件事）。
   * 现在：1..MAX_DEPTH 的整数照深度展开（逐层 BFS，防环 = 每节点只以最短跳数入表一次），
   * 越界/非整数 ⇒ 响亮报错并给出用法；结果超过 MAX_ITEMS ⇒ **响亮报错**并给出缩小范围的办法
   * （绝不静默截断 —— 截断后的"邻域"会被当成完整邻域来解读）。
   */
  related(ctx) {
    const id = ctx.args._[1];
    if (!id) ctx.error('用法: related <项目> <id> [--json] [--depth N]');
    // 深度：默认 1；必须是 1..MAX_DEPTH 的整数（0/负数/小数/文字一律报错，不猜）
    const rawDepth = ctx.args.depth;
    let depth = 1;
    if (rawDepth !== undefined) {
      const n = Number(rawDepth);
      if (!Number.isInteger(n) || n < 1 || n > relations.MAX_DEPTH) {
        ctx.error('--depth 必须是 1–' + relations.MAX_DEPTH + ' 的整数（收到 ' + JSON.stringify(rawDepth) + '）。'
          + '1 = 只看直接关联；2 = 两跳（间接关联的知识簇）；再大 = 继续往外扩，'
          + '但邻域超过 ' + relations.MAX_ITEMS + ' 条会响亮报错（那时把 --depth 调小、或换个更靠叶子的节点）');
      }
      depth = n;
    }
    const { data } = ctx.read();
    const self = ctx.tree.find(data.data, id);
    if (!self) ctx.error('节点不存在: ' + id);
    const all = loadAllProjects(ctx.PROJECTS_DIR);
    const r = relations.relatedAll(ctx.projectName, self, all, { depth, maxItems: relations.MAX_ITEMS });
    // 超上限：**响亮报错**，且把"怎么缩小"写清楚（静默截断是最坏的选择：读者会把残缺邻域当全部）
    if (r.truncated) {
      // 建议按**当前深度**给：depth=1 时"把 --depth 调小"是废话（再小就没有邻域了）
      const advice = depth > 1
        ? '把 --depth 调小（如 --depth 2）｜从更靠叶子的节点开始｜'
        : '从这个节点往外逐层看（它的**一跳邻居本身就超过上限**）｜换个更靠叶子的节点｜';
      ctx.error('--depth ' + depth + ' 的邻域在 ' + relations.MAX_ITEMS + ' 条处停下（再往外扩会把这颗星滚成整张图）。'
        + '缩小范围的办法：' + advice
        + '或先用 backlinks <项目> <id> 只看直接引用，再逐层往外交替看');
    }
    const out = Object.assign({ project: ctx.projectName, target: { id, topic: self.topic }, depth }, r);
    if (ctx.args.json) { ctx.outJson(out); return; }
    const layered = Object.keys(r.byDepth).map((d) => Number(d)).filter((d) => r.byDepth[d] > 0);
    ctx.out('「' + self.topic + '」的相关知识点（' + r.items.length + ' = '
      + layered.map((d) => (d === 1 ? '一跳 ' : d + ' 跳 ') + r.byDepth[d]).join(' + ')
      + '；直接引用 ' + r.outCount + ' / 被引用 ' + r.inCount + '）：');
    if (!r.items.length) { ctx.out('  （暂无相关节点）'); return; }
    const line = (x) => '  ' + arrowOf(x.dir) + ' ' + x.node + '  ' + x.topic
      + (x.project !== ctx.projectName ? '  [' + x.project + ']' : '')
      + (x.caption ? '  — ' + x.caption : '');
    // 一跳（直接关联）优先，更远的按跳数分组、归到「经由谁」之下，避免远近混在一起看不出层次
    r.items.filter((x) => x.depth === 1).forEach((x) => ctx.out(line(x)));
    const farDeps = layered.filter((d) => d > 1);
    farDeps.forEach((d) => {
      const far = r.items.filter((x) => x.depth === d);
      if (!far.length) return;
      ctx.out('');
      ctx.out('  ── ' + (d === 2 ? '二跳（经由上述节点间接关联）' : d + ' 跳（再往外一层）') + ' ──');
      const byVia = new Map();
      far.forEach((x) => {
        const k = x.via.project + '|' + x.via.node;
        if (!byVia.has(k)) byVia.set(k, { topic: x.via.topic, items: [] });
        byVia.get(k).items.push(x);
      });
      byVia.forEach((v) => {
        ctx.out('  经由「' + v.topic + '」：');
        v.items.forEach((x) => ctx.out(line(x)));
      });
    });
    if (depth === 1 && r.items.some((x) => x.depth === 1)) {
      ctx.out('');
      ctx.out('  提示：加 --depth 2 看两跳邻域（间接关联的知识簇），再往上可给更大整数（深度越深越容易撞结果上限）。');
    }
  },

  /**
   * 关系审计：列出没有任何引用关系的节点。
   *
   * 设计取舍（重要）：本命令**不做图谱渲染**，只做清单审计。
   * 原因：全量出图在 130+ 节点、大量纯结构节点时孤点占比可达 2/3，
   * 信噪比过低（详见 docs/ROADMAP.md「已否决」）。真正可行动的不是"图"，
   * 而是**含实质内容却无人引用**的节点 —— 故本命令把两者分开报：
   *   - contentOrphans：无引用 且 detail 非空 → **该处理的**（可能漏挂链接）
   *   - structural    ：无引用 且无 detail 的叶子 → 正常结构，不计入待办
   * 判定"有引用关系"只看 links（出边）与反向 links（入边），与 related 同源。
   */
  orphans(ctx) {
    const { data } = ctx.read();
    const selfProject = ctx.projectName;
    const all = loadAllProjects(ctx.PROJECTS_DIR);
    const nodes = ctx.tree.flatten(data.data);

    // 全项目入边索引：被链接到的 (project,id) 集合
    const inbound = new Set();
    all.forEach((p) => {
      relations.flatten(p.data.data).forEach((n) => {
        (n.links || []).forEach((l) => {
          if (l && l.project && l.id) inbound.add(l.project + '|' + l.id);
        });
      });
    });

    const isContentful = (n) => typeof n.detail === 'string' && n.detail.replace(/<[^>]*>/g, '').trim().length > 0;

    const contentOrphans = [];
    const structural = [];
    nodes.forEach((n) => {
      if (n.id === 'root') return;                    // 根是容器，不参与
      const outs = (n.links || []).length;
      const ins = inbound.has(selfProject + '|' + n.id) ? 1 : 0;
      if (outs || ins) return;                        // 有任一方向关系 → 不是孤儿
      const rec = {
        id: n.id, topic: n.topic,
        childCount: (n.children || []).length,
        hasDetail: isContentful(n),
        tags: Array.isArray(n.tags) && n.tags.length ? n.tags : undefined
      };
      if (rec.hasDetail) contentOrphans.push(rec);
      else structural.push(rec);
    });

    const limit = ctx.args.limit !== undefined ? Math.max(0, Number(ctx.args.limit)) : 40;
    const shown = (ctx.args.contentOnly ? contentOrphans : contentOrphans.concat(structural)).slice(0, limit);

    const summary = {
      project: selfProject,
      nodes: nodes.length,
      orphans: contentOrphans.length + structural.length,
      contentOrphans: contentOrphans.length,
      structural: structural.length,
      shown: shown.length
    };

    if (ctx.args.json) {
      ctx.outJson(Object.assign({}, summary, { items: shown }));
      return;
    }
    ctx.out(selfProject + '：共 ' + summary.nodes + ' 节点，其中 ' + summary.orphans
      + ' 个无引用关系（含内容 ' + summary.contentOrphans + ' / 纯结构 ' + summary.structural + '）');
    if (!summary.orphans) { ctx.out('  （无孤立节点）'); return; }
    ctx.out('');
    ctx.out('【该处理】无引用但有内容（' + contentOrphans.length + '）—— 建议补 links 或合并到他处：');
    if (!contentOrphans.length) ctx.out('  （无）');
    contentOrphans.slice(0, limit).forEach((r) => {
      ctx.out('  ' + r.id + '  ' + r.topic + (r.childCount ? '  (' + r.childCount + ' 子)' : '')
        + (r.tags ? '  [' + r.tags.join(',') + ']' : ''));
    });
    const shownStructural = shown.filter((r) => !r.hasDetail);
    if (!ctx.args.contentOnly && shownStructural.length) {
      ctx.out('');
      ctx.out('【无需处理】纯结构叶子（' + structural.length + '，仅列前 ' + shownStructural.length + '）：');
      shownStructural.forEach((r) => ctx.out('  ' + r.id + '  ' + r.topic));
    }
    if (ctx.args.contentOnly) return;
  },

  /**
   * 未链接提及：正文提到了某节点，却没有为它建 links。
   *
   * 与 orphans 的分工（互补，不可互替）：
   *   orphans  = 节点**完全没有**任何引用关系（横向：哪些知识点断了）→ 只告诉你"孤立了"
   *   mentions = 正文**提到了**却没声明关系（纵向：哪条关系漏了）→ 告诉你"该往哪连"
   * 实例：comnet 的 `switch`（交换机）被 4 个节点正文提到，却只有 1 个真的链接它。
   * 它有 1 条入边，所以**不是** orphans 报出的孤立节点 —— 只有 mentions 能发现它。
   *
   * 本命令只**报告**候选，不自动写 links：加链接是写操作，必须由人在 CLI/界面确认。
   *
   * --cross：额外扫描**跨项目**两个方向（in/out），语义见 src/mentions.js 的 findCrossMentions。
   *   同名歧义不猜：照报所有候选并标 ambiguous，另在 ambiguousTopics 汇总。
   */
  mentions(ctx) {
    const { data } = ctx.read();
    const common = {
      minTopicLength: ctx.args.minLength !== undefined ? Number(ctx.args.minLength) : undefined,
      limit: ctx.args.limit !== undefined ? Math.max(0, Number(ctx.args.limit)) : 0
    };
    const r = mentions.findMentions(data.data, Object.assign({
      selfProject: ctx.projectName,
      includeStructural: !!ctx.args.includeStructural
    }, common));

    const cross = ctx.args.cross
      ? mentions.findCrossMentions(loadAllProjects(ctx.PROJECTS_DIR), ctx.projectName, common)
      : null;

    const summary = {
      project: ctx.projectName,
      nodes: relations.flatten(data.data).length,
      candidates: r.candidates,
      mentions: r.items.length + (cross ? cross.items.length : 0),
      sameProject: r.items.length,
      crossOut: cross ? cross.outCount : 0,
      crossIn: cross ? cross.inCount : 0,
      ambiguousTopics: cross ? cross.ambiguousTopics : [],
      sources: r.sources,
      rawHits: r.raw,
      structuralSkipped: r.structuralSkipped,
      truncated: r.truncated || !!(cross && cross.truncated)
    };

    if (ctx.args.json) {
      ctx.outJson(Object.assign({}, summary, {
        items: cross ? r.items.concat(cross.items) : r.items
      }));
      return;
    }

    ctx.out(ctx.projectName + '：' + summary.nodes + ' 节点，' + summary.candidates + ' 个可作匹配目标');
    ctx.out('发现「正文提到但未建链接」' + summary.mentions + ' 处'
      + (cross ? '（本项目内 ' + summary.sameProject + ' + 跨项目 ' + (summary.crossOut + summary.crossIn) + '）' : '')
      + '，涉及 ' + summary.sources + ' 个来源节点');
    if (summary.structuralSkipped) {
      ctx.out('（另有 ' + summary.structuralSkipped + ' 处因"结构上已相邻（父子/祖孙）"被跳过'
        + '—— 树已表达该关系，加链接属冗余；--include-structural 可显示）');
    }
    if (!r.items.length && !(cross && cross.items.length)) {
      ctx.out('');
      ctx.out('（没有发现漏链接的提及；也可能是所有提及都已有链接或都被结构过滤）');
      return;
    }
    ctx.out('');
    // 按「被提及的目标」聚合：目标被越多来源提及，越说明它是被忽视的中枢
    const byTo = new Map();
    r.items.forEach((x) => {
      if (!byTo.has(x.to)) byTo.set(x.to, { topic: x.toTopic, froms: [] });
      byTo.get(x.to).froms.push(x.fromTopic);
    });
    const ranked = [...byTo.entries()].sort((a, b) => b[1].froms.length - a[1].froms.length);
    ranked.forEach(([id, v]) => {
      ctx.out('  ' + id + '「' + v.topic + '」被 ' + v.froms.length + ' 个节点提及，但无人链接：');
      v.froms.forEach((f) => ctx.out('        来源: ' + f));
    });

    if (cross && cross.items.length) {
      const show = (dir, label, hint) => {
        const list = cross.items.filter((x) => x.direction === dir);
        if (!list.length) return;
        ctx.out('');
        ctx.out('【跨项目 ' + label + '】' + list.length + ' 处 —— ' + hint);
        list.forEach((x) => {
          ctx.out('  ' + x.fromProject + '/' + x.from + '「' + x.fromTopic + '」'
            + (dir === 'out' ? '  →  ' : '  ←  ') + x.toProject + '/' + x.to + '「' + x.toTopic + '」'
            + (x.ambiguous ? '   ⚠ 同名歧义，需人工确认指向' : ''));
        });
      };
      show('out', '向外（本项目正文提到别的项目）', '可补一条指向外部的链接');
      show('in', '向内（别的项目正文提到本项目）', '可从外部补一条指向本项目的链接');
      if (cross.ambiguousTopics.length) {
        ctx.out('');
        ctx.out('⚠ 同名歧义主题（多个候选节点主题相同，本命令不猜，请人工选择）：'
          + cross.ambiguousTopics.join('、'));
      }
    } else if (ctx.args.cross) {
      ctx.out('');
      ctx.out('（跨项目扫描：未发现漏链接的提及）');
    }

    if (summary.truncated) ctx.out('\n（已按 --limit 截断；去掉 --limit 或调大以查看全部）');
  }
};
