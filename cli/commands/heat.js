/* ============================================================
 * cli/commands/heat.js — 「访问热度」（只读两条榜）+「记一次访问」（写一行）
 * ------------------------------------------------------------
 * 分工：**口径全在 `src/heat.js`** —— 通道权重表、窗口天数、名次→档位、日志格式与文件名
 * 各自只有那一处。本文件只做三件事：读参数 → 调它 → 把读数排成人能看的样子。
 * ⚠️ 因此这里**不许**出现通道名、权重数字、窗口天数、档位数（出现就是第二份会漂移的副本）
 * —— `tests/heat.test.js` 有一条机械断言盯着这件事。
 *
 * 两条命令：
 *   · `heat <项目>` —— 人 / AI 两条榜 + 每节点热度值 + **窗口内样本量**（如实暴露，不假装精确）；
 *   · `visit <项目> <节点id> --channel <通道>` —— 记一次访问（O(1)：只追加一行）。
 *
 * ⚠️ 口径（照 `changes` 命令的先例）：**"答不了"与"没有访问"必须可分辨**。
 *   本机没有访问日志（`src/heat.js` 的 `FILE_NAME`）⇒ 明说"没有访问日志"，**不等于"热度为 0"**，且不报错（那是可回答的事实）；
 *   日志坏了 / 有认不出的通道 / 时间乱序 / 未来时间戳 ⇒ **报错并非 0 退出**（F1），
 *   绝不静默给出一个看起来正常的榜。
 *
 * ⚠️ 本件（热度条第一件）不碰检索、不碰界面：这两条命令只回答"读得出来吗、读得对吗"。
 * ============================================================ */
'use strict';

const fs = require('fs');
const heat = require('../../src/heat.js');

/** 人类可读的时间（本地时区；日志用途是"最近什么时候被访问的"，秒精度够） */
function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso || '?');
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 字节数 → 人能读的量级（只用于回显，不参与判定） */
function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

/** 节点 id → 标题（只为可读性；**已删的节点如实标出来**，不假装它还在） */
function topicMap(root) {
  const map = new Map();
  const tree = require('../../src/tree-utils.js');
  tree.flatten(root).forEach((n) => { if (n && n.id) map.set(n.id, n.topic); });
  return map;
}

/** 榜上的一行：把热度与"它凭什么在这个位置"放在一起（名次 + 样本量） */
function decorate(rows, topics) {
  return rows.map((r) => ({
    node: r.node,
    topic: topics.has(r.node) ? topics.get(r.node) : null,
    missing: !topics.has(r.node),
    visits: r.visits,
    weighted: r.weighted,
    rank: r.rank,
    heat: r.heat
  }));
}

function labelOf(row) {
  if (row.missing) return row.node + '（节点已不存在）';
  return row.node + (row.topic ? ' ' + row.topic : '');
}

/** 窗口内真正用到的档位（样本少时档位稀疏 —— 这一行就是"不许假装精确"的证据） */
function usedBands(lists) {
  const set = new Set();
  lists.forEach((l) => l.forEach((r) => set.add(r.heat)));
  return [...set].sort((a, b) => b - a);
}

/** 数字定标（`avgHeat` 是浮点累加出来的：`0.7*3 = 2.0999999999999996` 这类噪音不许漏进 JSON） */
function r3(x) { return Math.round(Number(x) * 1000) / 1000; }

/**
 * 每个隐藏维度最多列几项（**只截显示**，不是排名口径）。
 * 取 20 的理由：一个项目的标签/章节数可以上百，全量倒出来会把 `--json` 撑成几百 KB，
 * 而"哪几维最热"看前 20 就够 —— 被截掉的部分仍以 `total` / `truncated` / `keys` 如实暴露
 * （**如实报数、不假装只有这几项**：这是本工程对"截断"的一贯口径）。
 */
const DIM_SHOW = 20;

/**
 * AI 侧**隐藏热度维度**（标签 / 章节 / 节点树）的展示折叠 —— **口径全在 `src/heat.js` 的
 * `derivedHeat()`**，本函数只做两件展示的事：① 按 `--dim-limit` 截断（**只截显示**，
 * 名次与档位仍是全量排名算的）；② 把"每维有几条"如实报出来（`total` / `shown`）。
 *
 * ⚠️ 本函数**只被 `heat --json` 调用** —— 渲染层一次都不调（界面只画节点自己的两条热度条）。
 */
function derivedView(computed, root, dimLimit) {
  const m = (rows) => {
    const total = rows.length;
    const shown = dimLimit > 0 ? rows.slice(0, dimLimit) : rows;
    return {
      total: total, shown: shown.length, truncated: total > shown.length,
      keys: rows.map((r) => r.key),
      items: shown.map((row) => ({
        key: row.key, label: row.label,
        heat: row.heat, rank: row.rank,                       // heat=0 + rank=null ⇒ 不在榜（这一维没被访问过）
        heatMax: row.heatMax, bestNode: row.bestNode, bestRank: row.bestRank,
        avgHeat: r3(row.avgHeat),                             // 成员平均档位（只作旁证，不是排名依据）
        nodes: row.nodes, visited: row.visited, events: row.events,
        hot: row.hot
      }))
    };
  };
  const d = heat.derivedHeat(computed, root, { top: 3 });
  return {
    human: { who: 'human', tags: m(d.human.tags), sections: m(d.human.sections), trees: m(d.human.trees) },
    ai: { who: 'ai', tags: m(d.ai.tags), sections: m(d.ai.sections), trees: m(d.ai.trees) },
    note: '这三个维度**全部由节点热度派生**（不是各记一套）：'
      + '标签 = 节点 `tags[]`；章节 = 节点在树里的每一级祖先（root 除外）；节点树 = 所属顶层主题。'
      + '一维的热度 = 它名下**最热的那个节点**的档位（名次沿节点榜，档位走同一个名次→十档映射）；'
      + '维度之间按这个"最强成员"的名次排名。每维都自带样本量：`nodes` 成员总数 / `visited` 其中被访问过的 '
      + '/ `events` 相关事件数 —— 少样本时档位会跳，**不许假装精确**（`visited=1` 的高档位要这么读）。'
      + '`heat=0` + `rank=null` = 这一维下没有任何节点在本窗口被访问过（**不等于**"热度为 0"）。'
      + '本字段**只出现在 `--json` 里**，界面（详情框）不显示它。'
  };
}

/** `--derived keys` 的一档：只要维度名清单（连成员/样本明细都不要 —— 维度名可能上百条） */
function keysOf(side) {
  const pick = (dim) => side[dim].keys;
  return { who: side.who, tags: pick('tags'), sections: pick('sections'), trees: pick('trees'),
    counts: { tags: side.tags.total, sections: side.sections.total, trees: side.trees.total } };
}

module.exports = {
  /**
   * `heat <项目> [--json] [--limit <n>]`
   *
   * 两条榜（人 / AI），各自在「窗口内被访问过的节点」这个子集内**按名次**排名。
   * `--limit` 只影响**显示条数**：热度一律按**全量**排名算（截断不影响名次）。
   */
  heat(ctx) {
    if (!ctx.projectName) ctx.error('用法：heat <项目> [--json] [--limit <n>] [--derived <summary|keys>] [--dim-limit <n>]');
    const projFile = ctx.store.projectFile(ctx.projectName);
    if (!fs.existsSync(projFile)) ctx.error('项目不存在: ' + ctx.projectName);
    const limit = ctx.intOption('limit', { min: 0, def: 50 });
    /* ---- AI 侧隐藏维度（热度条第三件 · B 块）：**必须显式要**，且只在 --json 里给 ----
     * 为什么必须显式：它是"给 AI 看的额外字段"，普通消费者（脚本 / 界面）不该被它改变载荷形状；
     * 为什么只在 --json：文本档加十几个维度会把"人读的那份"淹掉（而且文本档没有稳定的机器口径）。 */
    const dv = ctx.args.derived === undefined ? null : String(ctx.args.derived);
    if (dv !== null && dv !== 'summary' && dv !== 'keys') {
      ctx.error('--derived 只认两个值：`summary`（每维展开几项 + 样本量的摘要）｜`keys`（只要维度名清单，最省）。'
        + '收到 ' + JSON.stringify(dv) + '。它只对 `--json` 有意义。');
    }
    if (dv !== null && !ctx.args.json) {
      ctx.error('--derived 只在 `--json` 视图里有效（文本档是给人读的两条榜，不塞隐藏维度）。'
        + '要它：heat ' + ctx.projectName + ' --json --derived ' + dv);
    }

    // 项目文件只为把 id 翻成标题而读；**热度本身完全来自日志**（读不出来就报错，见 readHeatFile）
    const { data } = ctx.read();
    const topics = topicMap(data.data);
    const r = heat.readHeatFile(ctx.store.visitLogFile(ctx.projectName), { now: Date.now() });
    /* ---- `--node <id>`：把**某一个节点**的读数端出来（界面两条热度条要的就是它）----
     * 为什么要在 CLI 加这一档（而不是让界面在 `human`/`ai` 两个数组里找）：
     *   ① 那两个数组是**被 `--limit` 截断过的显示**，被访问过的节点可能恰好不在里面；
     *   ② 更重要的：**折算（名次→档位→该亮几格）必须只有一处**。让界面自己找、自己算分位，
     *      就是第二份会漂移的口径 —— 而界面显示的值必须与 CLI 的读数**逐字一致**。
     * 所以：档位映射在 `src/heat.js` 的 `heatProfile()`（唯一一处），本命令只把它摆进 JSON。
     * ⚠️ 它**不参与**截断：无论 `--limit` 多小、节点在不在显示窗口里，都按**全量排名**给读数。 */
    const wantNode = ctx.args.node === undefined ? null : String(ctx.args.node).trim();
    if (wantNode !== null && !wantNode) ctx.error('--node 需要一个节点 id：heat <项目> --json --node <id>');
    if (wantNode !== null && !ctx.args.json) {
      ctx.error('--node 只在 `--json` 视图里有效（文本档是给人读的两条榜）。'
        + '要它：heat ' + ctx.projectName + ' --json --node ' + wantNode);
    }
    const nodeView = wantNode === null ? null : heat.heatProfile(r.exists ? r.heat : null, wantNode);

    if (!r.exists) {
      if (ctx.args.json) {
        ctx.outJson({
          project: ctx.projectName, hasLog: false, file: r.file,
          window: { days: heat.WINDOW_DAYS },
          node: nodeView,                    // 没有日志时它是"未上榜"读数（**不是**"热度为 0"）
          note: '本机没有访问日志（`' + heat.FILE_NAME + '`）—— 这**不等于**"热度为 0"：'
            + '可能是本项目从未被本机记录过访问，或日志已被删除。'
        });
        return;
      }
      ctx.out('项目 ' + ctx.projectName + '：本机**没有访问日志**（`' + heat.FILE_NAME + '`）。');
      ctx.out('⚠ 这**不等于"热度为 0"** —— 日志由 `visit` 记一次访问就产生一行，可能是本项目'
        + '从未被记录过访问，或日志已被删除（它是旁路产物、可随时删）。');
      ctx.out('要开始记：`visit ' + ctx.projectName + ' <节点id> --channel ' + heat.CHANNEL_NAMES[0] + '`。');
      return;
    }

    const show = (list) => (limit > 0 ? list.slice(0, limit) : list);
    const humanAll = decorate(r.heat.human, topics);
    const aiAll = decorate(r.heat.ai, topics);
    const human = show(humanAll);
    const ai = show(aiAll);
    const bands = usedBands([r.heat.human, r.heat.ai]);
    const s = r.heat.sample;
    const log = r.log;

    if (ctx.args.json) {
      const payload = {
        project: ctx.projectName,
        hasLog: true,
        file: r.file,
        log: {
          bytesRead: log.bytesRead, fileBytes: log.fileBytes, fromOffset: log.fromOffset,
          windowComplete: log.complete, full: log.full, lines: log.lines, events: log.events
        },
        window: r.heat.window,
        sample: s,
        bands: bands,
        human: human,
        ai: ai,
        byChannel: r.heat.byChannel,
        weights: r.heat.weights,
        limit: { limit: limit, shownHuman: human.length, shownAi: ai.length, totalHuman: humanAll.length, totalAi: aiAll.length },
        // 单节点读数（`--node` 给了才有这个键；**按全量排名算，不受 --limit 影响**）——
        // 界面两条热度条读的就是它（档位映射的唯一一处：src/heat.js 的 heatProfile）
        node: nodeView,
        note: '热度 = 名次在**窗口内被访问过的节点**里的十档位置（只由名次决定，与次数的绝对值无关）；'
          + '零访问节点不进榜、不参与分位；样本少时档位会跳（见 sample 与 bands）。'
          + '⚠ `sample.dropped` 只统计**本次读到**的事件里被窗口排除的条数：'
          + '`log.windowComplete=false` 时（窄查询只读了尾部）它不是全量；'
          + '要全量口径请对照 `log.bytesRead == log.fileBytes`。'
      };
      if (dv !== null) {
        // AI 侧的隐藏维度（B 块）：**加在末尾**（既有消费者的字段位置与形状一个字节都不动）
        // ⚠️ 传的是 `data.data`（**树根**）：本函数要的是节点树，不是项目文件外壳 ——
        //    传错的表现是"维度全空"（`tags:[] components`、章节只剩自己），而且**不报错** ⇒
        //    `tests/heat-bars.test.js` 的 B1/B2/B6 盯着它（实测踩过这一次）。
        const view = derivedView(r.heat, data.data, DIM_SHOW);
        if (dv === 'keys') {
          // 最省的一档：只要"有哪些标签 / 章节 / 树"，不要成员明细（维度名可能上百条）
          payload.derived = {
            human: keysOf(view.human), ai: keysOf(view.ai), note: view.note
          };
        } else {
          payload.derived = view;
        }
      }
      ctx.outJson(payload);
      return;
    }

    /* ---------------- 文本档 ---------------- */
    const aiChannels = heat.CHANNELS.filter((c) => c.who === 'ai')
      .slice().sort((a, b) => b.weight - a.weight)
      .map((c) => c.ch + ' ' + c.weight).join(' > ');

    ctx.out('项目 ' + ctx.projectName + ' · 窗口 最近 ' + r.heat.window.days + ' 天（'
      + fmtTime(r.heat.window.from) + ' ~ ' + fmtTime(r.heat.window.to) + '）');
    ctx.out('样本：窗口内 ' + s.events + ' 条事件 / 被访问过的节点 ' + s.nodes + ' 个'
      + '（人 ' + s.humanEvents + ' 次 · AI ' + s.aiEvents + ' 次）'
      // ⚠️ 窄查询只读了尾部 ⇒ 这个数只统计**读到的部分**，措辞必须跟着变（不许把"读区内"说成"全部"）
      + (s.dropped ? ' · ' + (log.complete ? '窗口外丢弃 ' : '读区内窗口外丢弃 ') + s.dropped + ' 条' : ''));
    ctx.out('日志：读尾部 ' + fmtBytes(log.bytesRead) + '（文件 ' + fmtBytes(log.fileBytes)
      + (log.complete ? '，已覆盖整个窗口' : '，只读了尾部') + '）'
      + ' · 窗口内只用到 ' + bands.length + ' 个档位（' + (bands.length ? bands.join('/') : '无') + '）'
      + ' —— 样本少时档位会跳，这是**相对名次**的固有性质');
    if (humanAll.length > human.length || aiAll.length > ai.length) {
      ctx.out('（--limit ' + limit + ' 只截断显示；热度按**全量**排名算：人榜共 '
        + humanAll.length + ' 个、AI 榜共 ' + aiAll.length + ' 个）');
    }

    const rowLine = (row, extra) => '  #' + row.rank + '  ' + labelOf(row)
      + '  ' + extra + '  热度 ' + row.heat + '/' + heat.HEAT_BANDS;

    ctx.out('');
    ctx.out('人榜（' + heat.CHANNELS.filter((c) => c.who === 'human').map((c) => c.ch).join('/')
      + ' —— 人的访问只算这一种动作）');
    if (!human.length) ctx.out('  （窗口内没有被记录到的人类访问）');
    human.forEach((row) => ctx.out(rowLine(row, '事件 ' + row.visits + ' 次（加权 ' + row.weighted + '）')));

    ctx.out('');
    ctx.out('AI 榜（按**通道加权**排名：' + aiChannels + '）');
    if (!ai.length) ctx.out('  （窗口内没有被记录到的 AI 访问）');
    ai.forEach((row) => ctx.out(rowLine(row, '事件 ' + row.visits + ' 次（加权 ' + row.weighted + '）')));

    if (r.heat.byChannel.length) {
      ctx.out('');
      ctx.out('窗口内通道：' + r.heat.byChannel.map((c) => c.channel + ' ×' + c.events
        + '（权重 ' + c.weight + '）').join('、') + ' —— 取值与理由见 src/heat.js 的 CHANNELS（唯一一处定义）');
    }
    ctx.out('');
    ctx.out('口径：两条榜各自在**窗口内被访问过的节点**这个子集内按名次排名，零访问节点不进榜、'
      + '不参与分位；热度只由名次决定（同一节点访问次数 ×10 而名次不变 ⇒ 热度不变）。');
  },

  /**
   * `visit <项目> <节点id> --channel <通道> [--json]`
   *
   * 记一次访问 = 向**访问事件日志**追加一行（O(1)：不读全量、不重写文件、不加锁）。
   * 「谁（人/AI）」由通道决定（通道表只有一处）—— 调用方**不许**自报"我是人/AI"。
   * 时间取**写入时刻**（一次访问不该有两个时间；所以本命令**没有** `--at`）。
   */
  visit(ctx) {
    const id = ctx.args._[1];
    const ch = ctx.args.channel;
    if (!ctx.projectName || !id) {
      ctx.error('用法：visit <项目> <节点id> --channel <通道>\n  合法通道：'
        + heat.CHANNELS.map((c) => c.ch + '（' + c.label + '，权重 ' + c.weight + '）').join('\n              '));
    }
    if (ch === undefined || ch === null || ch === '') {
      ctx.error('缺少 --channel：要记的是**哪条通道**的一次访问？合法通道与权重（唯一一处定义：'
        + 'src/heat.js 的 CHANNELS）：\n  '
        + heat.CHANNELS.map((c) => c.ch + '（' + c.label + '，权重 ' + c.weight + '）').join('\n  '));
    }
    if (!heat.channelInfo(ch)) ctx.error(heat.unknownChannelError(ch, '命令行'));

    const projFile = ctx.store.projectFile(ctx.projectName);
    if (!fs.existsSync(projFile)) ctx.error('项目不存在: ' + ctx.projectName);

    const filed = heat.appendEvent(ctx.store.visitLogFile(ctx.projectName), {
      node: id, ch: ch, by: ctx.writer
    });
    const c = heat.channelRow(ch);
    if (ctx.args.json) {
      ctx.outJson({
        project: ctx.projectName, node: filed.entry.node, channel: c.ch, who: c.who,
        weight: c.weight, at: filed.entry.at, by: filed.entry.by || null,
        file: ctx.store.visitLogFile(ctx.projectName), bytes: filed.bytes
      });
      return;
    }
    ctx.out('已记一次访问：' + c.label + '（通道 ' + c.ch + ' · ' + (c.who === 'human' ? '人' : 'AI')
      + ' · 权重 ' + c.weight + '）→ ' + filed.entry.node + ' ｜ ' + fmtTime(filed.entry.at));
  }
};
