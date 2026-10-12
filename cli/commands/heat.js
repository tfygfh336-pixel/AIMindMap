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

module.exports = {
  /**
   * `heat <项目> [--json] [--limit <n>]`
   *
   * 两条榜（人 / AI），各自在「窗口内被访问过的节点」这个子集内**按名次**排名。
   * `--limit` 只影响**显示条数**：热度一律按**全量**排名算（截断不影响名次）。
   */
  heat(ctx) {
    if (!ctx.projectName) ctx.error('用法：heat <项目> [--json] [--limit <n>]');
    const projFile = ctx.store.projectFile(ctx.projectName);
    if (!fs.existsSync(projFile)) ctx.error('项目不存在: ' + ctx.projectName);
    const limit = ctx.intOption('limit', { min: 0, def: 50 });

    // 项目文件只为把 id 翻成标题而读；**热度本身完全来自日志**（读不出来就报错，见 readHeatFile）
    const { data } = ctx.read();
    const topics = topicMap(data.data);
    const r = heat.readHeatFile(ctx.store.visitLogFile(ctx.projectName), { now: Date.now() });

    if (!r.exists) {
      if (ctx.args.json) {
        ctx.outJson({
          project: ctx.projectName, hasLog: false, file: r.file,
          window: { days: heat.WINDOW_DAYS },
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
      ctx.outJson({
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
        note: '热度 = 名次在**窗口内被访问过的节点**里的十档位置（只由名次决定，与次数的绝对值无关）；'
          + '零访问节点不进榜、不参与分位；样本少时档位会跳（见 sample 与 bands）。'
          + '⚠ `sample.dropped` 只统计**本次读到**的事件里被窗口排除的条数：'
          + '`log.windowComplete=false` 时（窄查询只读了尾部）它不是全量；'
          + '要全量口径请对照 `log.bytesRead == log.fileBytes`。'
      });
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
