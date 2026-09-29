/* ============================================================
 * cli/commands/links.js — 跨项目链接命令
 * ------------------------------------------------------------
 * 链接约定：
 *   - 节点 links: [{ project, id, caption? }]
 *   - project 是另一个项目的目录名（projects/<project>/）
 *   - 悬挂链接（目标不存在）由 validate 检测
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const links = require('../../src/links.js');

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
    if (!ctx.tree.find(pre.data.data, id)) ctx.error('节点不存在: ' + id);
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
    ctx.mutate((data) => {
      const node = ctx.tree.find(data.data, id);
      if (!node) ctx.error('节点不存在: ' + id);          // 重放时可能已被别人删掉 ⇒ 报同一句话
      const link = { project: to, id: toId };
      if (ctx.args.caption) link.caption = ctx.args.caption;
      node.links = (node.links || []).filter((l) => !(l.project === to && l.id === toId)).concat(link);
      return data;
    });
    ctx.out('已添加链接: ' + id + ' → ' + to + '/' + toId);
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
