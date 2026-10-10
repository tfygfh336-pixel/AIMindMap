/* ============================================================
 * cli/commands/qa.js — `ask-apply`：把一次 AI 问答落进节点（详情 + 问答记录）
 * ------------------------------------------------------------
 * 为什么要有它：卖点 3 的原话是「在与内置 dsh 交流的同时可以让内置 dsh 直接展示思维导图和笔记」、
 * 「AI 产出直接落到节点与详情」—— 界面上问出了答案只是"看到了"，**没落到数据上**就等于没产出。
 * 而本工程的硬约束是**写操作只经 CLI**（闸门校验 + 原子写 + 并发版本闸门 + 写后回读），
 * 渲染层不直接改盘 ⇒ 这条命令就是"界面上的 AI 产出"唯一的落盘出口。
 *
 * 一次调用做三件事（**同一个 ctx.mutate ⇒ 一次原子写**，绝不写两次盘）：
 *   ① 追加 `qa` 记录（`{q,a,at,model?}`，**追加不覆盖**：问答是流水；完全相同的条目视为重复 ⇒ 幂等不追加）；
 *   ② 把带来源标记的问答追加到 `detail` 末尾（**HTML 存储**，形状在 src/qa.js —— 单一实现）；
 *   ③ `--as-child` 时在目标节点下新建一个子节点：标题取回答首行（截断）、详情放全文。
 *
 * 为什么 ①② 必须同一条命令：分两次调用要写两次盘 ⇒ 中间被打断就会留下"qa 记了、详情没写"
 * 这种自相矛盾的数据；而且两次写之间别人的改动会让并发闸门多报一次冲突（白折腾一次重放）。
 *
 * ⚠️ `at` 由**调用方**给（`--at`）：时间戳是"谁在什么时候落盘"的事实，界面知道那一刻，
 *   命令侧再取一次会与界面显示的对不上（同一件事两个时间）。缺省才取当前时间。
 *
 * ⚠️ 命令体里**不得出现 `await`**（`scripts/cli-integration.js` 进程内同步调用依赖这条不变量，
 *    `tests/cli-sync-invariant.test.js` 静态把守）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const qa = require('../../src/qa.js');
const markdown = require('../../src/markdown.js');

/** 回答文本：`--answer` 直接给，或 `--answer-file` 从文件读（长回答用，避开命令行长度与引号问题） */
function answerFromArgs(ctx) {
  const file = ctx.args.answerFile;
  if (!file) return ctx.args.answer;
  let text;
  try { text = fs.readFileSync(String(file), 'utf8'); }
  catch (e) {
    ctx.error('读不到回答文件：' + String(file) + '（' + ((e && e.message) || e) + '）');
  }
  return text;
}

module.exports = {
  askApply(ctx) {
    const id = ctx.args._[1];
    if (!id) ctx.error('缺少节点 id');
    const rawAnswer = answerFromArgs(ctx);
    // 空回答**响亮拒绝**（不许静默写一条空记录：那会在流水里留下一条"说了等于没说"的记录，
    // 而调用方拿到 exit 0 会以为落盘成功 —— 与 `--detail-md 内容为空` 同一口径）
    const answer = String(rawAnswer == null ? '' : rawAnswer);
    if (!answer.trim()) {
      ctx.error('回答为空（--answer / --answer-file 至少要有一个非空回答）：'
        + '没有内容的问答不该落进节点 —— 落盘就必须是能读的东西');
    }
    const question = String(ctx.args.question == null ? '' : ctx.args.question);
    const at = ctx.args.at ? String(ctx.args.at) : new Date().toISOString();
    const model = ctx.args.model ? String(ctx.args.model) : '';
    const asChild = !!ctx.args.asChild;
    const childId = ctx.args.childId ? String(ctx.args.childId) : null;

    const entry = qa.entryOf({ q: question, a: answer, at: at, model: model });
    // 结果必须记进闭包变量带出 mutate：并发重放会**再调用一次** fn（在里面 out() 会打印两次）
    let qaIndex = -1;
    let qaCount = 0;
    let duplicated = false;
    let child = null;

    ctx.mutate((data) => {
      const node = ctx.tree.find(data.data, id);
      if (!node) ctx.error('节点不存在: ' + id);
      // ① 问答记录（追加；完全相同的条目 ⇒ 幂等，不重复追加）
      const list = Array.isArray(node.qa) ? node.qa.slice() : [];
      const dup = list.findIndex((e) => e && e.q === entry.q && e.a === entry.a && e.at === entry.at);
      if (dup >= 0) {
        qaIndex = dup;
        duplicated = true;
      } else {
        list.push(entry);
        node.qa = list;
        qaIndex = list.length - 1;
      }
      qaCount = node.qa.length;
      // ② 详情追加（带来源标记与时间）
      node.detail = qa.appendToDetail(node.detail, entry);
      // ③ 子节点（标题 = 回答首行截断；详情 = 全文；同时把这条问答记在子节点上，
      //    于是"这个子节点是怎么来的"在数据里也读得出来 ✓）
      if (asChild) {
        const cid = childId || markdown.idGen(qa.deriveTitle(answer));
        if (ctx.tree.find(data.data, cid)) ctx.error('子节点 id 已存在: ' + cid);
        child = qa.childNodeOf(answer, cid);
        child.qa = [entry];
        node.children = (node.children || []).concat(child);
      }
      return data;
    });

    const out = {
      ok: true, project: ctx.projectName, node: id,
      qaIndex: qaIndex, qaCount: qaCount, duplicate: duplicated,
      child: child ? { id: child.id, topic: child.topic } : null
    };
    if (ctx.args.json) { ctx.outJson(out); return; }
    ctx.out('已落盘: ' + id + '（问答记录' + (duplicated ? '已存在，未重复追加' : '新增第 ' + (qaIndex + 1) + ' 条')
      + '；共 ' + qaCount + ' 条）'
      + (child ? '；新子节点 ' + child.id + '「' + child.topic + '」' : ''));
  }
};
