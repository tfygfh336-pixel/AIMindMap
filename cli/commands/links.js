/* ============================================================
 * cli/commands/links.js — 跨项目链接命令
 * ------------------------------------------------------------
 * 链接约定：
 *   - 节点 links: [{ project, id, caption? }]
 *   - project 是另一个项目的目录名（projects/<project>/）
 *   - 悬挂链接（目标不存在）由 validate 检测
 *
 * 重复 `link` **同一条边**的语义（K8 修复；改前是真机复现过的**静默丢字段**）：
 *   · 省略 --caption        ⇒ **保留**原有 caption（"重复添加"退化成幂等，绝不静默清掉）；
 *   · 显式给 --caption      ⇒ 覆盖（**空串 = 清空**，见下面 hasCaption 处的说明）；
 *   · 三种结局的回显**必须可分辨**：`已添加链接` / `已更新链接` / `无变化`。
 * 改前的实现把"要写下去的那条链接"从零重建（`{project, id, caption?}` 再 concat），于是
 * "没给 --caption"与"没有 caption"不可区分 —— 第二次 link 把盘上已有的 caption 抹掉，
 * 而回显与第一次**逐字相同**（`已添加链接: …`）：**成功与覆盖不可分辨** ✗。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const links = require('../../src/links.js');

/** 找出节点上指向 (project, id) 的那条边（没有则 null）。边按 (project,id) 唯一 —— 与 unlink 同口径。 */
function findEdge(node, project, id) {
  const list = node && Array.isArray(node.links) ? node.links : [];
  return list.find((l) => l && l.project === project && l.id === id) || null;
}

/**
 * 重复 `link` 同一条边的**语义判定**（纯函数、无 I/O ⇒ 可单测，见 `tests/link-caption.test.js`）。
 *
 * 判定的关键输入是 `hasCaption`（命令行**给没给** `--caption`），**不是** caption 的值 ——
 * 拿值的真假来判，`''`（显式清空）与 `undefined`（省略）就分不开，那正是这个缺陷的根因。
 *
 * @param {object|null} prev 盘上已有的那条边（没有 = null）
 * @param {boolean} hasCaption 是否给了 `--caption`
 * @param {string} [caption] 给了时的新说明（空串 = 显式清空）
 * @returns {{action:'add'|'update'|'clear'|'nochange', caption?:string, from?:string}}
 *          `from` = 改动前那份 caption（空串表示原本就没有）
 */
function planLink(prev, hasCaption, caption) {
  const next = hasCaption ? String(caption == null ? '' : caption) : null;
  if (!prev) return { action: 'add', caption: next === null ? '' : next };
  const from = typeof prev.caption === 'string' ? prev.caption : '';
  if (!hasCaption) return { action: 'nochange', from: from };   // 省略 ⇒ 保留原有说明
  if (next === from) return { action: 'nochange', from: from }; // 同说明重复 ⇒ 真·无变化
  if (next === '') return { action: 'clear', from: from };
  return { action: 'update', from: from, caption: next };
}

/** 某项目里是否存在某节点（跨项目目标要读盘）。不可读时给出 reason，调用方据此区分
 *  "确认不存在"（可清理）与"读不出来"（不许猜）。 */
function targetExists(ctx, project, nodeId) {
  const file = path.join(ctx.PROJECTS_DIR, project, project + '.json');
  if (!fs.existsSync(file)) return { ok: false, reason: '项目不存在: ' + project };
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { return { ok: false, reason: '无法读取 ' + project + '（' + ((e && e.message) || e) + '）' }; }
  const found = (function find(r) {
    if (!r) return false;
    if (r.id === nodeId) return true;
    return (r.children || []).some(find);
  })(data.data);
  return found ? { ok: true } : { ok: false, reason: '节点不存在: ' + project + '/' + nodeId };
}

module.exports = {
  link(ctx) {
    const id = ctx.args._[1];
    const to = ctx.args.to;
    const toId = ctx.args.id;
    if (!id || !to || !toId) ctx.error('用法: link <项目> <id> --to 目标项目 --id 目标id [--caption 说明]');
    // 校验顺序与报错文本**保持与从前一致**（B1：人按原有习惯操作得到的仍是设计意图）。
    // 目标项目那几项检查与"要写下去的数据"无关，放在 mutate 之外 —— 免得读盘代价被重放乘一遍。
    const pre = ctx.read();
    const preNode = ctx.tree.find(pre.data.data, id);
    if (!preNode) ctx.error('节点不存在: ' + id);
    // 目标项目存在性检查
    const targetFile = path.join(ctx.PROJECTS_DIR, to, to + '.json');
    if (!fs.existsSync(targetFile)) ctx.error('目标项目不存在: ' + to);
    const targetData = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    const found = (function find(r) {
      if (!r) return false;
      if (r.id === toId) return true;
      return (r.children || []).some(find);
    })(targetData.data);
    if (!found) ctx.error('目标节点不存在: ' + to + '/' + toId);
    if (to === ctx.projectName && toId === id) ctx.error('不能链接到自身');

    // ⚠️ **必须问"给没给 --caption"，不能看它的值**：省略时 `args.caption` 是 undefined、
    // 显式空串时是 ''，两者的真假完全一样 —— 拿值判就等于把"保留"和"清空"混成一句。
    const hasCaption = Object.prototype.hasOwnProperty.call(ctx.args, 'caption');
    if (hasCaption && typeof ctx.args.caption !== 'string') {
      // 只写 `--caption` 不给值（parseArgs 给 `true`）：旧实现会把 true 原样写进链接
      // （盘上出现 `"caption": true`，而 validate 不查 caption 类型 ⇒ 一路静默）。
      // 这里响亮拒绝并给出两条正路。⚠️ 这条**排在既有全部检查之后**：老调用方的报错顺序不变。
      ctx.error('--caption 需要一个说明文本（省略 --caption = 保留原说明；要清空请显式写 --caption ""）');
    }
    const caption = hasCaption ? ctx.args.caption : '';

    const target = to + '/' + toId;
    const report = (p) => {
      if (p.action === 'add') { ctx.out('已添加链接: ' + id + ' → ' + target); return; }
      if (p.action === 'nochange') {
        ctx.out('无变化: ' + id + ' → ' + target + '（链接已存在，未改动；'
          + (p.from ? 'caption: ' + p.from : '无 caption') + '）');
        return;
      }
      if (p.action === 'clear') {
        ctx.out('已更新链接: ' + id + ' → ' + target + '（caption 清空；原 caption: ' + p.from + '）');
        return;
      }
      ctx.out('已更新链接: ' + id + ' → ' + target + '（caption: ' + (p.from || '（无）') + ' → ' + p.caption + '）');
    };

    // 先探一次（用刚读到的这一版）：盘上已是目标状态就**不产生空写入** ——
    // 与 `links-prune` 的先探后写同一口径。不只是省一次写：`store.write` 还会追加一条
    // `.changes.jsonl`，空写入会让别的会话在 `changes` 里看到"有人动过这里"的假信号。
    const prePlan = planLink(findEdge(preNode, to, toId), hasCaption, caption);
    if (prePlan.action === 'nochange') { report(prePlan); return; }

    let plan = prePlan;
    ctx.mutate((data) => {
      const node = ctx.tree.find(data.data, id);
      if (!node) ctx.error('节点不存在: ' + id);          // 重放时可能已被别人删掉 ⇒ 报同一句话
      plan = planLink(findEdge(node, to, toId), hasCaption, caption);
      if (plan.action === 'nochange') return data;        // 并发期间别人已改成同一状态 ⇒ 一个字节都不动
      if (plan.action === 'add') {
        const link = { project: to, id: toId };
        if (caption) link.caption = caption;              // 空串 = 不落 caption 键（= 这条边没有说明）
        node.links = (node.links || []).concat(link);
        return data;
      }
      // update / clear：**在原对象上改 caption**，不重建对象 —— 边上的其它字段（实测会被旧写法
      // 顺手抹掉的 `note`，以及将来可能有的 `item`）与数组顺序都保持不动。
      // （同一条边在数据里若有多条历史副本，一起改 —— 不让它们各说各话；条数不变。）
      (node.links || []).forEach((l) => {
        if (!l || l.project !== to || l.id !== toId) return;
        if (plan.action === 'clear') delete l.caption;
        else l.caption = plan.caption;
      });
      return data;
    });
    report(plan);
  },

  unlink(ctx) {
    const id = ctx.args._[1];
    const to = ctx.args.to;
    const toId = ctx.args.id;
    if (!id || !to || !toId) ctx.error('用法: unlink <项目> <id> --to 目标项目 --id 目标id');
    ctx.mutate((data) => {
      const node = ctx.tree.find(data.data, id);
      if (!node) ctx.error('节点不存在: ' + id);
      const before = (node.links || []).length;
      node.links = (node.links || []).filter((l) => !(l.project === to && l.id === toId));
      if (node.links.length === before) ctx.error('链接不存在: ' + id + ' → ' + to + '/' + toId);
      return data;
    });
    ctx.out('已移除链接');
  },

  links(ctx) {
    const { data } = ctx.read();
    const out = [];
    ctx.tree.walk(data.data, (n) => {
      (n.links || []).forEach((l) => out.push({ node: n.id, topic: n.topic, project: l.project, id: l.id, caption: l.caption }));
    });
    if (ctx.args.json) ctx.outJson({ project: ctx.projectName, links: out });
    else out.forEach((l) => ctx.out(l.node + ' → ' + l.project + '/' + l.id + (l.caption ? '  ' + l.caption : '')));
  },

  /**
   * 清理悬空链接（修好"悬挂链接"导致的校验红）。
   *   links-prune <项目>                 → 自动找出**确认不存在**的目标并删掉这些链接（默认）
   *   links-prune <项目> --nodes a,b     → 只删指向本项目 a/b 的链接（删节点时用）
   *   links-prune <项目> --dry-run       → 只报告，不写盘
   *
   * 存在意义：链接可以指向**别的项目**，那个项目把节点删掉后，本项目的链接就悬空，
   * validate 判红 → 本项目**所有**写操作都被闸门挡住，而界面上没有"删链接"的入口。
   * 有没有它，决定了"别人删了个节点"能不能自己修好 —— 这与 assoc-prune 是同一类修法。
   */
  linksPrune(ctx) {
    const { data: pre } = ctx.read();
    const all = links.allLinks(pre.data);
    if (!all.length) { ctx.out('本项目暂无链接，无需清理'); return; }

    let should;
    if (ctx.args.nodes !== undefined) {
      const raw = String(ctx.args.nodes).split(',').map((s) => s.trim()).filter(Boolean);
      if (!raw.length) ctx.error('--nodes 内容为空（如 --nodes a,b,c）');
      const set = new Set(raw);
      should = (l) => l.project === ctx.projectName && set.has(String(l.id));
      ctx.out('按 --nodes 清理指向本项目这些节点的链接: ' + raw.join(', '));
    } else {
      // 自动模式：只删**能确认不存在**的目标。项目读不出来（损坏/权限）不算"不存在"——
      // 按"采不到真值 = 红"的规矩，不确定就不猜，单独列出来警告。
      const gone = new Set();
      const unknown = new Set();
      all.forEach((x) => {
        const l = x.link;
        if (!l || typeof l.project !== 'string' || typeof l.id !== 'string') return;
        const r = targetExists(ctx, l.project, l.id);
        if (r.ok) return;
        if (/^无法读取/.test(r.reason)) unknown.add(l.project + '/' + l.id);
        else gone.add(l.project + '|' + l.id);
      });
      if (unknown.size) {
        ctx.out('⚠ 以下目标所在项目读不出来，**不**当作悬空处理（请先修好项目再清理）:');
        unknown.forEach((k) => ctx.out('    · ' + k));
      }
      if (!gone.size) {
        ctx.out('没有悬挂链接，无需清理' + (unknown.size ? '（上面读不出来的除外）' : ''));
        return;
      }
      ctx.out('发现悬挂链接: ' + Array.from(gone).map((k) => k.replace('|', '/')).join(', '));
      should = (l) => gone.has(l.project + '|' + l.id);
    }

    // 先探一次：没有可清理的就不写盘（保持"不产生空写入"）
    const probe = links.pruneLinks(pre.data, should);
    if (!probe.changed) { ctx.out('没有需要清理的链接'); return; }

    let r = probe;
    let alreadyClean = false;
    if (!ctx.args.dryRun) {
      // **并发安全**：判据 `should` 在 fn **外**固定 —— 它依赖**别的项目**的读盘（目标是否还在），
      // 而 fn 里禁止 I/O（并发重放会再调用它一次）。重放只按"我核实过的那份名单"剪，不猜新的。
      // 收益：两个会话同时修、或修的同时别人在改**别的节点**时，不再整体失败。
      ctx.mutate((cur) => {
        const out = links.pruneLinks(cur.data, should);
        r = out;
        if (!out.changed) { alreadyClean = true; return cur; }
        return cur;
      });
    }
    if (alreadyClean) { ctx.out('并发期间这些链接已被其他写入者清掉，本次无需改动'); return; }
    const tag = ctx.args.dryRun ? '[dry-run] 将要' : '已';
    r.removed.forEach((x) => ctx.out(tag + '删除链接: ' + x.node + ' → ' + x.target));
    if (ctx.args.dryRun) ctx.out('（--dry-run：未写盘）');
    else ctx.out('共清理 ' + r.removed.length + ' 条链接，涉及 ' + r.nodes.length + ' 个节点');
  }
};
