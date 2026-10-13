/* ============================================================
 * cli/commands/assoc.js — 「关联笔记」命令
 * ------------------------------------------------------------
 *   assoc-list   <项目> [--node <id>] [--json]
 *   assoc-add    <项目> --members a,b,c [--title 标题] [--note html | --note-md md] [--id id] [--force]
 *   assoc-edit   <项目> <assocId> [--title 标题] [--note html | --note-md md] [--clear-note] [--members a,b,c]
 *   assoc-remove <项目> <assocId>
 *
 * 为什么关联是**独立实体**而不是挂在 links 上（设计依据，见 docs/DATA-FORMAT.md）：
 *   links 是逐条声明的有向边，图结构上能表达三角/互指，但表达不了"把若干节点的关联
 *   当成一个对象"。挂在边上时：标题只能写两端（第三个成员消失）、重跑 `link` 会整个
 *   替换链接对象从而**抹掉笔记**、`unlink` 会让笔记陪葬。独立实体没有这些问题。
 *
 * 存储：项目 JSON 的顶层可选 `assoc` 集合（与 `data` 平级）；note 与节点 detail 同约定
 * —— 落盘是 **HTML**，Markdown 只出现在命令行边界（--note-md）。
 * 纯逻辑（解析/校验/查询）在 src/assoc.js，本文件只做参数处理 + 读写 + 输出。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const assoc = require('../../src/assoc.js');
const convert = require('../../src/convert.js');
const concurrency = require('../../src/concurrency.js');
const { SKIP_WRITE } = require('../core.js');

/** 取本次命令要写入的 note（HTML）。与 edit.js 的 detailFromArgs 同规矩：互斥、显式声明。 */
function noteFromArgs(ctx) {
  const html = ctx.args.note;
  const md = ctx.args.noteMd;
  if (html !== undefined && md !== undefined) {
    ctx.error('--note 与 --note-md 不能同时使用（前者按 HTML 原样存，后者按 Markdown 转换）');
  }
  if (md !== undefined) {
    if (typeof md !== 'string' || !md.trim()) ctx.error('--note-md 内容为空');
    return convert.markdownToHtml(md);
  }
  return html;
}

/** 目标项目里的节点是否存在（跨项目成员要读盘） */
function nodeExistsIn(ctx, project, nodeId) {
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

/** 校验每个成员都真实存在（与 `link` 同样的前置检查，避免造出悬挂关联） */
function assertMembersExist(ctx, members) {
  members.forEach((m) => {
    const r = nodeExistsIn(ctx, m.project, m.id);
    if (!r.ok) ctx.error(r.reason);
  });
}

/**
 * 「同一篇」指纹（S7 的语义去重）—— 成员集合 + 标题 + 正文三者都同才算。
 *
 * 与 `edit.js` 的节点去重同一条思路（宁窄勿宽：漏判比误判轻）：
 *   · **成员集合**按 `项目/id` 排序后比较 —— 成员的**书写顺序**不参与判定
 *     （`--members a,b` 与 `--members b,a` 是同一篇关联，这点与 `parseMembers` 的去重口径一致）；
 *   · 标题去首尾空白后逐字比；note 比**内容指纹**（同 edit.js 的做法）。
 * 为什么必须防这一条：`assoc-add` 的 id 由 `src/assoc.js` 的 `genId` 生成（含**时间 + 随机**），
 * 重跑一次同一条命令**不会**撞 id、只会多出一篇一模一样的关联 —— 正是"重试变成重复生效"。
 */
function assocKeyOf(a) {
  const members = (a && Array.isArray(a.members) ? a.members : [])
    .map((m) => String((m && m.project) || '') + '/' + String((m && m.id) || ''))
    .sort();
  const note = (a && a.note !== undefined && a.note !== null && a.note !== '')
    ? concurrency.hash(String(a.note)) : '';
  return JSON.stringify({
    m: members,
    t: String((a && a.title) || '').trim(),
    n: note
  });
}

/** 「已有一篇相同的」拒绝文案（**点名那篇** + 两条出路） */
function dupAssocRefusal(dup) {
  return '已存在成员/标题/正文完全相同的关联笔记：' + dup.id
    + (dup.title ? '（标题 ' + dup.title + '）' : '') + '。\n'
    + '这是一次**重复新增**（重试/重跑最常见的形态）—— 默认拒绝，以免同一篇进两遍。\n'
    + '两条出路：\n'
    + '  · 想**加第二篇**：加 --force（那是有意的重复，不是手滑）；\n'
    + '  · 想**改那一篇**：用 assoc-edit <项目> ' + dup.id + ' …，别再加一篇。';
}

/** 项目里所有节点的 项目→id→topic（用于把成员解析成可读标题） */
function topicResolver(ctx) {
  const cache = {};
  return (project, nodeId) => {
    if (!cache[project]) {
      const file = path.join(ctx.PROJECTS_DIR, project, project + '.json');
      cache[project] = {};
      if (fs.existsSync(file)) {
        try {
          const d = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
          (function w(n) { if (!n) return; cache[project][n.id] = n.topic; (n.children || []).forEach(w); })(d.data);
        } catch (e) { /* 读不到就当解析不出标题，memberLabel 会回退成 项目/id */ }
      }
    }
    return cache[project][nodeId];
  };
}

/** 输出用的视图：补上解析后的成员标题与"有效标题"（作者没写就用成员主题拼） */
function viewOf(a, topicOf) {
  const members = (a.members || []).map((m) => ({
    project: m.project,
    id: m.id,
    topic: topicOf(m.project, m.id) || null,
    label: assoc.memberLabel(m, topicOf)
  }));
  return {
    id: a.id,
    title: a.title || '',
    effectiveTitle: a.title || assoc.autoTitle(a, topicOf),
    members: members,
    note: a.note || '',
    hasNote: !!(a.note && String(a.note).trim())
  };
}

module.exports = {
  assocList(ctx) {
    const { data } = ctx.read();
    const all = Array.isArray(data.assoc) ? data.assoc : [];
    const nodeId = ctx.args.node;
    const picked = nodeId ? assoc.forNode(all, ctx.projectName, nodeId) : all;
    const topicOf = topicResolver(ctx);
    const items = picked.map((a) => viewOf(a, topicOf));

    if (ctx.args.json) {
      const out = { project: ctx.projectName, node: nodeId || null, count: items.length, items: items };
      // `--raw` 额外给出**原始实体**（未经视图包装、只含契约字段）。
      // 用途：渲染层读一次就能把内存里的 assoc 与磁盘对齐 —— 界面保存时写回的是内存那份，
      // 若内存是旧的就等于用旧值覆盖磁盘。给 raw 而不是让渲染层自己从视图里挑字段，
      // 是为了把"数据形状"这件事继续留在 CLI 侧（渲染层不复制契约知识）。
      if (ctx.args.raw) out.raw = picked.map((a) => JSON.parse(JSON.stringify(a)));
      ctx.outJson(out);
      return;
    }
    if (!items.length) {
      ctx.out(nodeId ? '该节点暂无关联笔记' : '本项目暂无关联笔记');
      return;
    }
    items.forEach((it) => {
      ctx.out(it.id + '  ' + it.effectiveTitle + (it.hasNote ? '' : '  （尚无笔记）'));
      it.members.forEach((m) => ctx.out('    · ' + m.label + (m.topic ? '' : '  [' + m.project + '/' + m.id + ']')));
    });
  },

  assocAdd(ctx) {
    const raw = ctx.args.members;
    if (raw === undefined) ctx.error('缺少 --members（如 --members a,b,c；跨项目写 项目/节点id）');
    const parsed = assoc.parseMembers(raw, ctx.projectName);
    if (!parsed.ok) ctx.error(parsed.error);
    assertMembersExist(ctx, parsed.members);
    const note = noteFromArgs(ctx);
    let added = null;                                   // 闭包变量：带出实际落盘的条目（重放时 id 可能是新生成的）
    // 语义去重（S7）：成员集合 + 标题 + 正文都同 ⇒ **拒绝**，但先把候选条目在本函数里
    // **构造好**（但**不入 `data.assoc`**）—— 拒绝必须在不写盘的前提下发生。
    // ⚠️ 不能"先 push 再返回 null 表示拒绝"：`mutate` 的返回值就是**要写盘的数据**，
    //    返回 null 会让写入与 `changedKeys` 直接崩（实测形态：`Cannot read properties of null`）。
    const candidate = { members: parsed.members };
    if (ctx.args.title !== undefined) candidate.title = ctx.args.title;
    if (note !== undefined) candidate.note = note;
    let dup = null;
    ctx.mutate((data) => {
      if (!Array.isArray(data.assoc)) data.assoc = [];
      const key = assocKeyOf(candidate);
      const hit = data.assoc.find((a) => a && assocKeyOf(a) === key);
      if (hit && !ctx.args.force) { dup = { id: hit.id, title: hit.title || '' }; return SKIP_WRITE; }  // 盘上零改动
      const id = ctx.args.id || assoc.genId(data.assoc);
      if (!assoc.ID_RE.test(String(id))) ctx.error('关联 id 不合规范（小写字母/数字/连字符）: ' + id);
      if (data.assoc.some((a) => a && a.id === id)) ctx.error('关联 id 已存在: ' + id);

      const item = { id: id, members: parsed.members };          // 字段顺序与从前一致（落盘字节可比）
      if (candidate.title !== undefined) item.title = candidate.title;
      if (candidate.note !== undefined) item.note = candidate.note;
      data.assoc.push(item);
      added = item;
      if (hit) added.duplicateOf = hit.id;                // --force 下的有意重复（回显里说明）
      return data;
    });
    if (dup) ctx.error(dupAssocRefusal(dup));
    if (added.duplicateOf) {
      ctx.out('⚠ 已存在同一篇关联 ' + added.duplicateOf + '，本次是 --force 下的**有意重复**');
    }
    const topicOf = topicResolver(ctx);
    ctx.out('已新增关联 ' + added.id + '：' + (added.title || assoc.autoTitle(added, topicOf))
      + '（' + parsed.members.length + ' 个成员）');
    if (note === undefined) {
      ctx.out('提示：尚未写笔记，可用 assoc-edit ' + ctx.projectName + ' ' + added.id + ' --note-md "…" 补充');
    }
  },

  assocEdit(ctx) {
    const id = ctx.args._[1];
    if (!id) ctx.error('用法: assoc-edit <项目> <assocId> [--title 标题] [--note html | --note-md md] [--clear-note] [--members a,b,c]');
    ctx.mutate((data) => {
      const list = Array.isArray(data.assoc) ? data.assoc : [];
      const item = list.find((a) => a && a.id === id);
      if (!item) ctx.error('关联不存在: ' + id);

      let changed = 0;
      if (ctx.args.title !== undefined) { item.title = ctx.args.title; changed++; }
      if (ctx.args.members !== undefined) {
        const parsed = assoc.parseMembers(ctx.args.members, ctx.projectName);
        if (!parsed.ok) ctx.error(parsed.error);
        assertMembersExist(ctx, parsed.members);
        item.members = parsed.members;
        changed++;
      }
      if (ctx.args.clearNote) { delete item.note; changed++; }
      const note = noteFromArgs(ctx);
      if (note !== undefined) { item.note = note; changed++; }

      if (!changed) ctx.error('没有指定要修改的内容（--title / --note / --note-md / --clear-note / --members）');
      return data;
    });
    ctx.out('已更新关联 ' + id);
  },

  assocRemove(ctx) {
    const id = ctx.args._[1];
    if (!id) ctx.error('用法: assoc-remove <项目> <assocId>');
    ctx.mutate((data) => {
      const list = Array.isArray(data.assoc) ? data.assoc : [];
      const before = list.length;
      data.assoc = list.filter((a) => !(a && a.id === id));
      if (data.assoc.length === before) ctx.error('关联不存在: ' + id);
      // 全部删完就把键去掉，保持"没有关联的项目"与旧格式完全一致（不留空数组噪音）
      if (!data.assoc.length) delete data.assoc;
      return data;
    });
    ctx.out('已移除关联 ' + id);
  },

  /**
   * 清理关联里的成员，修好"悬挂成员"导致的校验红。
   *   assoc-prune <项目>              → 自动找出**确认不存在**的成员并清理（默认）
   *   assoc-prune <项目> --nodes a,b  → 只清理本项目里这几个节点
   *   assoc-prune <项目> --dry-run    → 只报告，不写盘
   *
   * 存在意义：删节点（CLI 的 remove / 界面删除）会留下悬挂成员，validate 随即判红。
   * 有了它，任何被卡住的项目都能一条命令修好，不必手写 assoc-edit --members。
   */
  assocPrune(ctx) {
    const { data: pre } = ctx.read();
    const list = Array.isArray(pre.assoc) ? pre.assoc : [];
    if (!list.length) { ctx.out('本项目暂无关联笔记，无需清理'); return; }

    let should;
    if (ctx.args.nodes !== undefined) {
      const raw = String(ctx.args.nodes).split(',').map((s) => s.trim()).filter(Boolean);
      if (!raw.length) ctx.error('--nodes 内容为空（如 --nodes a,b,c）');
      const bad = raw.find((id) => !assoc.ID_RE.test(id));
      if (bad) ctx.error('节点 id 不合规范（小写字母/数字/连字符）: ' + bad);
      const set = new Set(raw);
      should = (m) => m.project === ctx.projectName && set.has(String(m.id));
      ctx.out('按 --nodes 清理本项目成员: ' + raw.join(', '));
    } else {
      // 自动模式：只清理**能确认不存在**的成员。项目读不出来（损坏/权限）不算"不存在"——
      // 按"采不到真值 = 红"的规矩，不确定就不能猜，单独列出来警告。
      const gone = new Set();
      const unknown = new Set();
      list.forEach((a) => (a.members || []).forEach((m) => {
        if (!m || typeof m.project !== 'string' || typeof m.id !== 'string') return;
        const r = nodeExistsIn(ctx, m.project, m.id);
        if (r.ok) return;
        if (/^无法读取/.test(r.reason)) unknown.add(m.project + '/' + m.id);
        else gone.add(m.project + '|' + m.id);
      }));
      if (unknown.size) {
        ctx.out('⚠ 以下成员所在项目读不出来，**不**当作悬空处理（请先修好项目再清理）:');
        unknown.forEach((k) => ctx.out('    · ' + k));
      }
      if (!gone.size) {
        ctx.out('没有悬挂成员，无需清理' + (unknown.size ? '（上面读不出来的除外）' : ''));
        return;
      }
      ctx.out('发现悬挂成员: ' + Array.from(gone).map((k) => k.replace('|', '/')).join(', '));
      should = (m) => gone.has(m.project + '|' + m.id);
    }

    // 先按预读的数据**探一次**：没有任何可清理的就不写盘（保持与从前一致的"不产生空写入"）
    const probe = assoc.pruneMembers(list, should);
    if (!probe.changed) { ctx.out('没有需要清理的成员'); return; }

    let r = probe;
    let alreadyClean = false;
    /* 【W8】写盘**不再在这里分流**：一律调 `ctx.mutate`，由 `cli/core.js` 的中央短路决定
     * "只报告还是真写"（判定 / 打印 / 短路只有那一处，见那里的 `planWrite`）。
     * 从前这里写的是 `if (!ctx.dryRun) { ctx.mutate(...) }`（见 links-prune 同款注释）。
     * ⚠️ **并发安全**：判据 `should` 在 fn **外**固定 —— 它依赖**别的项目**的读盘（成员是否还在），
     * 而 fn 里禁止 I/O（并发重放会再调用它一次）。
     * 于是重放时只按"**我核实过的那份名单**"剪，**不猜新的**（"不确定就不删"的规矩不变；
     * 跨项目视角陈旧这一点在改造前也一样存在，不是本次引入的）。
     * 收益：两个会话同时修同一个项目时，后者重放到已修好的数据上 ⇒ **幂等地无事可做**。 */
    ctx.mutate((cur) => {
      const out = assoc.pruneMembers(Array.isArray(cur.assoc) ? cur.assoc : [], should);
      r = out;
      if (!out.changed) { alreadyClean = true; return cur; }   // 并发下已被别人清掉
      // 清空就删键，与 assoc-remove 的约定一致（不留空数组噪音）
      if (out.empty) delete cur.assoc; else cur.assoc = out.list;
      return cur;
    });
    if (alreadyClean) { ctx.out('并发期间这些成员已被其他写入者清掉，本次无需改动'); return; }
    const tag = ctx.dryRun ? '[dry-run] 将要' : '已';
    r.touched.forEach((t) => ctx.out(tag + '清理 ' + t.removed + ' 个成员: ' + t.id));
    r.dropped.forEach((id) => ctx.out(tag + '删除整篇关联（清理后不足 ' + assoc.MIN_MEMBERS + ' 个成员）: ' + id));
    if (ctx.dryRun) ctx.out('（--dry-run：未写盘）');
    else if (r.empty) ctx.out('关联已全部清空，assoc 键已移除');
  }
};
