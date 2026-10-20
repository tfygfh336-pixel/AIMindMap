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
 *   source-chain <项目> <id> [--json] [--depth N] [--reverse]
 *     出处链（产品代号 `SC`，台账 `W17`）：**只沿** `links[].caption` 以「出自：」开头的边多跳，
 *     逐跳给出节点与那一跳的出处原文；`--reverse` 反查（谁把我当出处）。
 *     与 `related` 的区别：那个是**无类型区分**的双向邻域（浏览相关），这个是**有向 + 有类型**的溯源。
 *     成环 ⇒ 响亮拒绝并逐条点名环上的边（不丢边凑合）；撞上限 ⇒ 响亮报错（不静默截断）。只读。
 *     ⚠️ `出自：` 是 `docs/TAGS.md` §11 那**一个**写法；真实数据里另有 560 条 `来源：`
 *     （`learn-path` 生成）本命令**有意不认**，但会如实报进 `otherPrefixes`（见 src/source-chain.js 文件头）。
 *   orphans <项目> [--json] [--content-only] [--limit n]
 *     关系审计：找出「无任何引用关系」的节点，并把其中**含实质内容**的挑出来
 *     —— 那才是真正该处理的部分（纯结构型叶子节点无内容是正常的，不算问题）。
 *   mentions <项目> [--json] [--min-length n] [--include-structural] [--cross] [--limit n]
 *     未链接提及：正文**提到了**某节点却没有为它建 links —— orphans 缺失的另一半。
 *     --cross 额外扫描跨项目两个方向（in/out），同名歧义不猜、照报并标记
 *   contents <项目> [--json] [--depth N] [--parent <id>] [--min-count N] [--apply]
 *     概念目录（功能代号 `CC`，台账 `W16`）：把树**聚合成一份按书内出现顺序排的概念清单**
 *     （同名合并、每条带落点 id）；`--apply` 才在指定父节点下生成/就地更新「概念索引」分支。
 *     **它是"概念提取"，不是关系查询** —— 与上面三条同族（都从既有数据里提取视图），
 *     但它不回答"谁引用了谁"，而是回答"这棵树讲了哪些概念"。计算在 src/mentions.js 的
 *     `conceptCatalog` / `indexBranch`（与 `mentions` **共用**同一份命中计算）。
 * 计算逻辑在 src/relations.js 与 src/mentions.js（UMD，单测覆盖纯部分；本项目做 fs 注入）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const relations = require('../../src/relations.js');
const mentions = require('../../src/mentions.js');
/** 「经验来源链（`SC`）」的判据唯一实现处（UMD 纯逻辑：方向、分流、环检测、上限都在那里） */
const sourceChainMod = require('../../src/source-chain.js');

/** `source-chain` 的**缺省深度**（命令层的取值，只此一处；上限在 `src/source-chain.js` 的 `MAX_DEPTH`） */
const SOURCE_DEPTH_DEFAULT = 10;
/** 「这次别写盘」的哨兵（`cli/core.js` 的唯一实现）：`contents --apply` 发现"已经是最新的"时用它
 *  ⇒ `ctx.mutate` 一次盘都不写、`.changes.jsonl` 也不多一条（幂等的判据见命令体）。 */
const { SKIP_WRITE } = require('../core.js');

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

/** `contents` 人读档里"中间层级"那一截的最大长度（**只与内容有关、与终端宽度无关** ⇒ 输出仍可逐字节复现） */
const VIA_MAX = 64;

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
    // ---- 埋点（热度条第三件 · C）：顺着关系**走到**这些节点 ⇒ 通道 `ai-related-hop`（中间强度：
    //      比搜索命中更有指向性，但不是按 id 直取）。记的是**本次真的返回的邻域**（含起点自己：
    //      `related` 本来就把"我"的邻域一起交代了，起点也是被访问的对象）。
    //      ⚠️ 上限截断（返回顺序的前缀）与失败口径都只有一处：src/heat-sensor.js。
    //      `backlinks` **有意不记**：它读的是同一张关系图的另一个方向，而"一跳"这件事
    //      若两条命令各记一次，同一个动作会被算两遍（宁可少记，不许重复计一次访问）。
    ctx.recordVisit('ai-related-hop', [id].concat(r.items.map((x) => x.node)));
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
   * 出处链（产品代号 `SC`，台账 `W17`）：沿 `links[].caption` 以「出自：」开头的边**多跳**追溯。
   *
   * ## 它回答的问题（既有命令都答不了的那一半）
   *   · `backlinks` / `related` —— 只看**无类型区分**的边，且 `related` 把出边入边混在一起 ⇒
   *     判不出"哪一条边是出处"，也走不出"只沿出处"的那条链。
   *   · `origin` —— 只到**文件**为止（`origin.src` 是路径），结构上不可能多跳。
   *   ⇒ 本命令是「出处链」这条语义的**唯一实现**，计算全在 `src/source-chain.js`（UMD 纯逻辑）。
   *
   * ## 方向（**唯一答案**，与 `docs/TAGS.md:347` 给 `前置：` 立的那句同构）
   *   `出自：` 写在**下游**节点上、目标 = **上游（来源）**。⇒ 默认沿出边 = 溯源；
   *   `--reverse` 沿入边 = 反查（谁把我当出处）。两个方向共用同一份环检测。
   *
   * ## 三条硬口径
   *   ① **只读**：一次盘都不写（不进 `WRITE_COMMANDS`、不碰 `.changes.jsonl`、**不记热度** ——
   *      `related` 记 `ai-related-hop` 是因为它是"浏览"，溯源是一次查询；记了还会让 `--json` 两跑不可比）；
   *   ② **成环响亮拒绝并逐条点名**（`src/source-chain.js` 的 `cycleMessage`），不丢边凑合；
   *   ③ **撞上限响亮报错**，绝不静默截断（照 `related` 撞 `MAX_ITEMS` 的既有口径）。
   */
  sourceChain(ctx) {
    const id = ctx.args._[1];
    if (!id) ctx.error('用法: source-chain <项目> <节点id> [--json] [--depth N] [--reverse]');
    const depth = ctx.intOption('depth', { min: 1, max: sourceChainMod.MAX_DEPTH, def: SOURCE_DEPTH_DEFAULT });
    const reverse = !!ctx.args.reverse;
    const { data } = ctx.read();
    const self = ctx.tree.find(data.data, id);
    if (!self) ctx.error('节点不存在: ' + id);

    // 跨项目索引：项目**按名排序**后再建 ⇒ 输出与 readdir 的返回顺序无关（`--json` 可复现的一部分）
    const all = loadAllProjects(ctx.PROJECTS_DIR).slice()
      .sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));
    const nIdx = relations.nodeIndex(all);

    const topicAt = (p, nid) => {
      const box = nIdx[p];
      const n = box && box[nid];
      return n ? n.topic : null;            // null = 目标节点解析不到（悬挂/项目没了），如实标
    };

    // 正向：该节点的**全部**出边（`src/source-chain.js` 自己按 caption 分流）
    const outEdges = (p, nid) => {
      const box = nIdx[p];
      const n = box && box[nid];
      if (!n) return [];
      return (Array.isArray(n.links) ? n.links : [])
        .filter((l) => l && typeof l.project === 'string' && typeof l.id === 'string')
        .map((l) => ({ project: l.project, id: l.id, topic: topicAt(l.project, l.id), caption: l.caption }));
    };

    // 反向：入边索引（**全部**入边，不只出处边 —— 这样 `otherPrefixes` 在两个方向上是同一个读数）
    let inEdges = null;
    if (reverse) {
      const inIdx = Object.create(null);
      all.forEach((p) => {
        relations.flatten(p.data.data).forEach((n) => {
          (Array.isArray(n.links) ? n.links : []).forEach((l) => {
            if (!l || typeof l.project !== 'string' || typeof l.id !== 'string') return;
            const k = sourceChainMod.nodeKey(l.project, l.id);
            if (!inIdx[k]) inIdx[k] = [];
            inIdx[k].push({ project: p.name, id: n.id, topic: n.topic, caption: l.caption });
          });
        });
      });
      inEdges = (p, nid) => inIdx[sourceChainMod.nodeKey(p, nid)] || [];
    }

    const r = sourceChainMod.walk({
      start: { project: ctx.projectName, id, topic: self.topic },
      edgesOf: reverse ? inEdges : outEdges,
      maxDepth: depth
    });
    if (r.ok === false && r.code === 'cycle') ctx.error(sourceChainMod.cycleMessage(r.cycles));
    if (r.ok === false && r.code === 'too-many') ctx.error(sourceChainMod.tooManyMessage(r));

    // ⚠️ 键序固定（`G-11` 先例）：无时间戳、无随机、无 `rev`/`version` ⇒ 两跑 sha256 相同
    const out = {
      ok: true,
      project: ctx.projectName,
      target: { id: id, topic: self.topic },
      direction: reverse ? 'down' : 'up',
      depth: depth,
      chains: r.chains,
      hopCount: r.hopCount,
      otherPrefixes: r.otherPrefixes,
      nearMiss: r.nearMiss,
      truncated: r.truncated
    };
    if (ctx.args.json) { ctx.outJson(out); return; }

    ctx.out('「' + self.topic + '」的出处链（'
      + (reverse ? '反查：谁把我当出处（越来越下游）' : '溯源：沿「出自：」向来源走')
      + '，最多 ' + depth + ' 跳）：');
    const real = r.chains.filter((c) => c.length > 1);
    if (!real.length) {
      ctx.out('  （0 跳）这个节点没有「出自：」' + (reverse ? '入边' : '出边')
        + ' —— 它的' + (reverse ? '下游引用' : '来源') + '还没有被记录下来。');
      if (!reverse) {
        ctx.out('  写法：node cli/mm-cli.js link ' + ctx.projectName + ' ' + id
          + ' --to <来源项目> --id <来源节点> --caption "出自：<哪本书 / 哪一节 / 哪个 URL>"');
      }
    }
    real.forEach((chain, ci) => {
      ctx.out('');
      ctx.out('  链 ' + (ci + 1) + '（' + (chain.length - 1) + ' 跳）：');
      chain.forEach((h, hi) => {
        const topic = (h.topic === null) ? '（目标节点不存在）' : h.topic;
        ctx.out('    [' + hi + '] ' + h.project + ':' + h.id + '  ' + topic);
        if (h.caption) ctx.out('         ' + h.caption);
      });
    });
    const pk = Object.keys(r.otherPrefixes);
    if (pk.length) {
      ctx.out('');
      ctx.out('  没跟的边（caption 不是「出自：」开头，按前缀计数）：'
        + pk.map((k) => k + ' ' + r.otherPrefixes[k]).join(' · '));
    }
    if (r.nearMiss.length) {
      ctx.out('');
      ctx.out('  ⚠ 近失写法 ' + r.nearMiss.length + ' 条（以「出自」开头但不是「出自：」⇒ 不算出处边；'
        + '这种写法会让一条出处声明**静默失效**，所以报出来）：');
      r.nearMiss.forEach((x) => ctx.out('    ' + x.node + '  ' + x.caption));
    }
    if (r.truncated) {
      ctx.out('');
      ctx.out('  ⚠ 有链走到 --depth ' + depth + ' 的界、后面还有出处边没走 —— '
        + '要看全就调大 --depth（上限 ' + sourceChainMod.MAX_DEPTH + '）');
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

    // --limit：非法值当场报错（`--limit abc` 以前会静默变成 NaN ⇒ `slice(0,NaN)` = 空清单 ✗）
    const limit = ctx.intOption('limit', { min: 0, def: 40 });
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
    // --min-length / --limit 的非法值当场报错（0 = 不限条数，与既有语义一致）
    const common = {
      minTopicLength: ctx.intOption('minLength', { min: 1, def: undefined }),
      limit: ctx.intOption('limit', { min: 0, def: 0 })
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
  },

  /**
   * 概念目录（功能代号 `CC`，台账 `W16`，名字权威见 `docs/FEATURES.md`）。
   *
   * ## 它回答的是哪一句人话
   *   「**这棵树讲了哪些概念**」。一棵书树里只有"章节容器"和"叶子知识点"，读者想问这句话时
   *   只能自己从几百个节点里挑一遍。本命令把树**聚合成一份按书内出现顺序排的概念清单**
   *   （同名合并、每条带落点 id），并可选地把这份清单**一键补成节点**（生成「概念索引」分支）。
   *
   * ## 它是"概念提取"，不是关系查询（与上面三条的分工）
   *   `backlinks` / `related` / `mentions` 回答"**谁和谁有关系**"；`contents` 回答"**这棵树讲了哪些
   *   概念、各在哪儿**"。共用的是**同一份命中计算**（`src/mentions.js` 的 `findMentions` ——
   *   `count` 里"正文提及数"那一半逐条来自它），不是同一张报表。
   *
   * ## 「什么算一个概念」的可复算判据 —— **只在 `src/mentions.js` 的 `conceptCatalog` 一处**
   *   （候选面 = 前序遍历、作用域根不算；承载体 = 有正文/有标签/有链接/是叶子；
   *     概念名 = 标题去章节号前缀；count = 落点数 + 正文提及数）。本命令不另写一份口径。
   *
   * ## 写入那一半（`--apply`）三件事
   *   ① **不带 `--apply` 时绝不写盘**（只读那一半一次 `ctx.write` / `ctx.mutate` 都不调）；
   *   ② 写在**新分支**「概念索引」下（挂在 `--parent` 指定的节点，缺省 `root`），
   *      每个概念一个子节点，`links[]` 用工程既有的链接语法回指落点，`caption` 是自由文本
   *      （**不带类型前缀**：`docs/TAGS.md` §11 的类型只有 5 种，"索引条目"不是其中任何一种，
   *      该节规则 2 明写"允许不带任何类型前缀"）；
   *   ③ **幂等**：这一支认 `id` 或 `topic`（`src/mentions.js` 的 `CONCEPT_INDEX_ID` /
   *      `CONCEPT_INDEX_TOPIC`）⇒ 第二次跑**就地更新**，绝不造第二份；内容一致时返回
   *      `SKIP_WRITE`（**一个字节都不写**，连 `.changes.jsonl` 都不多一条）。
   *      概念节点的 id 由概念名哈希而来（`shortHash`，不含时间/随机）⇒ 清单不变则 id 不变。
   */
  contents(ctx) {
    /* `--apply` 是**纯开关**：带值的写法一律响亮拒绝（照 `--dry-run` 的先例）。
     * 为什么不能猜：`--apply=false` 当成"开"会把一次预览变成真写；当成"关"又会让一次
     * 本该写的调用**静默不写**（调用方以为写了）—— 两种都危险，所以唯一的正解是不猜。 */
    if (ctx.args.apply !== undefined && ctx.args.apply !== true) {
      ctx.error('--apply 是**纯开关**（不带值）：写法 `… --apply`。要"不写盘"就把这个开关去掉'
        + '（`--apply=false` 这类两态写法本工程一律**响亮拒绝**：猜错方向两种都危险 ——'
        + '当成"开"会把一次预览变成真写，当成"关"会让一次本该写的调用静默不写）。（收到 '
        + JSON.stringify(ctx.args.apply) + '）');
    }
    const wantApply = ctx.args.apply === true;
    const parentId = (ctx.args.parent === undefined || ctx.args.parent === null) ? '' : String(ctx.args.parent).trim();
    const depth = ctx.intOption('depth', { min: 1, def: 0 });        // 0 = 不限层数
    const minCount = ctx.intOption('minCount', { min: 1, def: 1 });
    const { data } = ctx.read();
    const scopeRoot = parentId ? ctx.tree.find(data.data, parentId) : data.data;
    if (!scopeRoot) ctx.error('节点不存在: ' + parentId);
    const catalogOpts = { depth: depth, minCount: minCount, selfProject: ctx.projectName };
    const catalog = mentions.conceptCatalog(scopeRoot, catalogOpts);

    const payload = {
      project: ctx.projectName,
      scope: {
        parent: parentId || null,
        parentTopic: parentId ? String(scopeRoot.topic) : null,
        depth: depth || null,
        minCount: minCount
      },
      nodes: catalog.scanned,
      carriers: catalog.carriers,
      concepts: catalog.concepts,
      shown: catalog.shown,
      mentions: catalog.mentions,
      withMentions: catalog.withMentions,
      duplicates: catalog.duplicates,
      items: catalog.items
    };

    /* 人读档：**一次 `ctx.out` 打完整段**（不是逐行打）——
     * dry-run 的中央标记是按"每条消息首行"加的，逐行打会让每一行都挂上标记（见 `cli/core.js` 的 `out`）。 */
    const listLines = () => {
      const lines = [];
      lines.push(ctx.projectName + '：扫 ' + catalog.scanned + ' 个节点 → 承载体 ' + catalog.carriers
        + ' · 概念 ' + catalog.concepts
        + (catalog.shown !== catalog.concepts ? '（--min-count ' + minCount + ' 只列 ' + catalog.shown + ' 个）' : '')
        + '；顺序 = 第一次出现的位置（不是按次数排行）');
      lines.push('口径：概念名 = 标题去章节号前缀 · 同名合并；count = 落点数 + 正文提及数'
        + '（提及与 mentions 命令同一实现：src/mentions.js 的 findMentions）');
      lines.push('      正文提及合计 ' + catalog.mentions + ' 处，涉及 ' + catalog.withMentions + ' 个概念；'
        + '多落点概念 ' + catalog.duplicates + ' 个'
        + (parentId ? '；作用域 = 「' + String(scopeRoot.topic) + '」子树' : '；作用域 = 整棵树'));
      if (!catalog.shown) { lines.push('  （没有可提取的概念）'); return lines; }
      lines.push('');
      const width = String(catalog.shown).length;
      catalog.items.forEach((c, i) => {
        // 只保留"中间层级"（去掉作用域根与概念自身）；太长就留**离它最近**的那一截 ——
        // 截断只跟内容长度有关，与终端宽度无关 ⇒ 两次跑仍逐字节相同（G-11 同一条纪律）。
        let via = c.pathNames.slice(1, Math.max(1, c.pathNames.length - 1)).join(' / ');
        if (via.length > VIA_MAX) via = '…' + via.slice(-(VIA_MAX - 1));
        lines.push('  ' + String(i + 1).padStart(width, ' ') + '. ' + c.name
          + '  落点 ' + c.nodes + ' · 提及 ' + c.mentions + ' · #' + c.firstId
          + (via ? '   ← ' + via : ''));
      });
      return lines;
    };

    if (!wantApply) {
      if (ctx.args.json) { ctx.outJson(payload); return; }
      ctx.out(listLines().join('\n'));
      if (ctx.dryRun) {
        ctx.out('（本次只读：没给 --apply ⇒ 一个字节都没写。`--dry-run` 的"将改哪些对象"只在 '
          + '--apply 时才有对象可报）');
      }
      return;
    }

    /* ---- 写入那一半 ----
     * 走 `ctx.mutate`：并发自动重放 / 写盘前校验 / `--dry-run` 中央短路 / 幂等键 都在那一条管道上，
     * 本命令**一条都不另写**。改动函数里在"将要写下去的那份数据"上**重算一遍清单**
     * （与上面只读那一半同一个 `conceptCatalog`），所以预览与真跑不可能给出两份读数。 */
    const state = {
      parentId: '', parentTopic: '', branchId: '',
      created: false, updated: false, unchanged: false, empty: false, childNodes: 0, links: 0
    };
    ctx.mutate((d) => {
      const target = parentId ? ctx.tree.find(d.data, parentId) : d.data;
      if (!target) ctx.error('节点不存在: ' + parentId);
      state.parentId = String(target.id === undefined ? '' : target.id);
      state.parentTopic = String(target.topic === undefined ? '' : target.topic);
      const inner = mentions.conceptCatalog(target, catalogOpts);
      // `scopeId` 让非根作用域生成物的 id 带后缀（否则给子树再生成一支时会撞 id —— 实测过）
      const desired = mentions.indexBranch(inner.items, { project: ctx.projectName, scopeId: target.id });
      state.childNodes = desired.children.length;
      state.links = desired.children.reduce((n, c) => n + ((c.links || []).length), 0);
      // 0 个概念 ⇒ **不造空壳分支**（一个没有条目的"索引"只会让人以为生成失败）
      if (!inner.items.length) { state.empty = true; return SKIP_WRITE; }
      const kids = Array.isArray(target.children) ? target.children.slice() : [];
      let at = -1;
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i];
        if (c && (c.id === desired.id || mentions.isConceptIndexNode(c))) { at = i; break; }
      }
      if (at >= 0) {
        // 就地更新：**保留**这一支上用户自己加的东西（`expanded` / `localPath` …），只换生成物那四样
        const existing = kids[at];
        state.branchId = String(existing.id === undefined ? '' : existing.id);
        const next = Object.assign({}, existing, {
          topic: desired.topic, detail: desired.detail, links: desired.links, children: desired.children
        });
        if (mentions.sameIndexBranch(next, existing)) { state.unchanged = true; return SKIP_WRITE; }
        kids[at] = next;
        state.updated = true;
      } else {
        state.branchId = desired.id;
        kids.push(desired);
        state.created = true;
      }
      target.children = kids;
      return d;
    });

    payload.apply = {
      parent: state.parentId || null,
      parentTopic: state.parentTopic || null,
      branchId: state.branchId || null,
      created: state.created,
      updated: state.updated,
      unchanged: state.unchanged,
      childNodes: state.childNodes,
      links: state.links
    };
    if (ctx.args.json) { ctx.outJson(payload); return; }

    const tail = [];
    tail.push(listLines().join('\n'));
    tail.push('');
    if (state.empty) {
      tail.push('没有可提取的概念（作用域内 0 个承载体）⇒ 不生成空的「概念索引」，本次未写盘');
    } else {
      const where = '（挂在「' + state.parentTopic + '」下）';
      const figures = state.childNodes + ' 个概念条目、' + state.links + ' 条回指落点的链接';
      if (state.created) tail.push('已创建「概念索引」' + where + '：' + figures);
      else if (state.updated) tail.push('已就地更新「概念索引」' + where + '：' + figures);
      else {
        tail.push('「概念索引」已是最新' + where + '：' + figures
          + ' —— 本次**未写盘**（幂等：同一份清单生成同一支；第二次不会造第二份）');
      }
    }
    ctx.out(tail.join('\n'));
  }
};
