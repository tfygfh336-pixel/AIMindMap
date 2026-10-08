/* ============================================================
 * cli/commands/dsh-ask.js —— 向内嵌 DSH 提问（功能 1 的后端命令）
 * ------------------------------------------------------------
 *   ask <项目> <id> [--question "..."] [--kind explain|ask] [--json]
 *       [--timeout 秒] [--dry-run]
 *
 * 为什么 CLI 先有、界面后有：界面上「解释 / 问问AI」两个按钮最终点的是**同一条通道**，
 * 把它先做成可机械验证的命令行，就不必为了"能不能问答"去开界面（本工程的老规矩：先能跑通
 * 再上界面，且失败要能单独定位 ✓）。
 *
 * `--dry-run` = 只打印**将要发给 AI 的完整提示词**与命令行，**不调用模型**：
 *   · 让门禁能在**不烧额度、不依赖网络**的前提下检查"AI 到底收到什么"（情境有没有补齐）；
 *   · 也是使用者自查"为什么它答偏了"的第一入口 ✓
 *
 * 通道细节与实测数据见 `src/dsh-ask.js` 的文件头。
 * ============================================================ */
'use strict';

const path = require('path');
const fs = require('fs');
const dshAsk = require('../../src/dsh-ask.js');
const convert = require('../../src/convert.js');

/** 正文转纯文本（HTML→Markdown 后截断；提示词不追求完整，追求"够 AI 判语境"） */
function detailToText(html, limit) {
  if (!html) return '';
  let text = '';
  try { text = convert.htmlToMarkdown ? convert.htmlToMarkdown(html) : String(html); }
  catch (e) { text = String(html); }
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  const max = limit || 1500;
  return text.length > max ? text.slice(0, max) + '…（已截断）' : text;
}

/** 相关知识点摘要（我引用谁 / 谁引用我），最多 8 条 —— 够交代语境即可 */
function relatedToText(relations, projectName, node, all, tree) {
  try {
    const r = relations.relatedAll(projectName, node, all, { depth: 1 });
    const items = (r.items || []).slice(0, 8);
    if (!items.length) return '';
    return items.map((x) => {
      const arrow = x.dir === 'out' ? '→' : x.dir === 'in' ? '←' : '↔';
      const t = x.topic || (tree && x.node ? (tree.find(null, x.node) || {}).topic : '') || x.node;
      return arrow + ' ' + t + (x.project && x.project !== projectName ? '［' + x.project + '］' : '');
    }).join('；');
  } catch (e) { return ''; }
}

/** 收集情境（**一处定义**：界面与 CLI 都走这里，免得"AI 收到什么"有两份说法）。
 *  节点是**可选**的：消息栏那条入口常在没有选中节点时使用（项目级提问 ✓）。 */
function collectContext(ctx) {
  const id = ctx.args._[1];
  if (!id) {
    // 项目级：只给项目与"你能动手做什么"（见 src/dsh-ask.js 的 buildContextBlock）
    return {
      project: ctx.projectName,
      projectRoot: path.resolve(__dirname, '..', '..'),
      projectLevel: true,
      nodeId: null, topic: null, pathText: '', tags: [], detailText: '', relatedText: ''
    };
  }
  const { data, file } = ctx.read();
  const node = ctx.tree.find(data.data, id);
  if (!node) ctx.error('节点不存在: ' + id);
  const all = [];
  try {
    fs.readdirSync(ctx.PROJECTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .forEach((e) => {
        const f = path.join(ctx.PROJECTS_DIR, e.name, e.name + '.json');
        if (!fs.existsSync(f)) return;
        try { all.push({ name: e.name, data: JSON.parse(fs.readFileSync(f, 'utf8')) }); } catch (err) { /* 跳过坏项目 */ }
      });
  } catch (e) { /* 没有 projects 目录就只按本项目算 */ }
  const chain = (ctx.tree.pathTo ? ctx.tree.pathTo(data.data, id) : null) || [node];
  // ⚠️ `pathTo` 返回的是 **id 数组**（不是节点对象）—— 第一版按节点取 `.topic` ⇒ 路径全是空的
  //（实测 dry-run 打出「 /  /  / 」才现形 ✗）。这里统一映射成标题、并滤掉映射不到的空位。
  const pathText = chain
    .map((x) => (x && typeof x === 'object' ? x.topic : (ctx.tree.find(data.data, x) || {}).topic))
    .filter(Boolean).join(' / ');
  // 工程根 = **仓库根**（不是 projects 目录）：给 AI 交代"你在哪个工程里"，它才好用 CLI 自查
  const projectRoot = path.resolve(__dirname, '..', '..');
  return {
    project: ctx.projectName,
    projectRoot: projectRoot,
    nodeId: id,
    topic: node.topic,
    pathText: pathText,
    tags: Array.isArray(node.tags) ? node.tags : [],
    detailText: detailToText(node.detail),
    relatedText: relatedToText(require('../../src/relations.js'), ctx.projectName, node, all, ctx.tree),
    node: node
  };
}

module.exports = {
  ask(ctx) {
    const info = collectContext(ctx);
    const kind = ctx.args.kind === 'explain' ? 'explain' : 'ask';
    const question = ctx.args.question || '';
    // 项目级提问必须有内容 —— 「解释这个节点」在项目级没有意义（没有节点可解释 ✗）
    if (!info.nodeId && !question) ctx.error('项目级提问要带 --question "…"（或改用 ask <项目> <节点id> --kind explain）');
    if (kind === 'ask' && !question) ctx.error('--kind ask 需要 --question "…"（或直接用 --kind explain）');
    const prompt = dshAsk.buildAskPrompt(Object.assign({}, info, { kind, question }));
    const runtime = dshAsk.resolveAskRuntime({ repoRoot: path.resolve(__dirname, '..', '..') });
    const timeoutSec = Number(ctx.args.timeout) > 0 ? Number(ctx.args.timeout) : undefined;

    // ⚠️ 参数名是**驼峰**（cli/core.js 把 `--dry-run` 解析成 `args.dryRun`）。
    //    第一版写成 `ctx.args['dry-run']` ⇒ 标志被**静默忽略**、白白烧了一次真模型调用 ✗
    //    （实测：本该 0.4s 的 dry-run 跑了 23.3s 才现形）。tests/dsh-ask.test.js 锁死这条契约。
    if (ctx.args.dryRun) {
      const out = {
        ok: true, dryRun: true, project: info.project, target: { id: info.nodeId, topic: info.topic },
        kind, prompt, timeoutMs: (timeoutSec ? timeoutSec * 1000 : dshAsk.DEFAULT_TIMEOUT_MS),
        command: { node: runtime.node, args: [runtime.dsh].concat(dshAsk.buildAskArgs(prompt)), cwd: process.cwd(), dshHome: runtime.home }
      };
      if (ctx.args.json) { ctx.outJson(out); return; }
      ctx.out('（--dry-run：只打印将要发给 AI 的内容，**没有调用模型** ✓）');
      ctx.out('命令行：' + runtime.node + ' ' + runtime.dsh + ' headless "<下面这段>"');
      ctx.out('DSH_HOME：' + runtime.home);
      ctx.out('超时：' + Math.round(out.timeoutMs / 1000) + 's');
      ctx.out('---- 提示词 ----');
      prompt.split('\n').forEach((l) => ctx.out(l));
      return;
    }

    const r = dshAsk.askOnce({
      runtime, prompt, timeoutMs: timeoutSec ? timeoutSec * 1000 : undefined
    });
    if (ctx.args.json) {
      ctx.outJson({ ok: r.ok, project: info.project, target: { id: info.nodeId, topic: info.topic },
        kind, ms: r.ms, code: r.code, text: r.text, error: r.error || null });
      if (!r.ok) process.exitCode = 1;
      return;
    }
    if (!r.ok) ctx.error('向内嵌 DSH 提问失败（' + r.ms + 'ms）：' + r.error);
    ctx.out('「' + info.topic + '」' + (kind === 'explain' ? '的解释' : '') + '（' + (r.ms / 1000).toFixed(1) + 's）：');
    ctx.out(r.text);
  }
};
